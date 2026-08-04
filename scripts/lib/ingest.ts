/**
 * Transcript ingestion — the one workflow that turns a Claude Code
 * user→assistant turn into an Echo thought: cheap prefilter, Haiku
 * relevance gate, then an idempotent capture on the shared pipeline.
 *
 * The Stop hook (last turn), catch-up (whole sessions), and the mine CLI
 * (history with budget) are adapters that differ only in which turns they
 * feed in and what policy they wrap around the calls.
 *
 * Two entries cross this seam: ingestTurn gates a raw turn through Haiku;
 * ingestRaw captures a thought that has already decided it's worth keeping
 * (e.g. a compaction bookmark) and so skips the gate. Skipping the gate is a
 * choice made by calling ingestRaw — not a path that reaches around the
 * module — so the source_id convention, the capture-input shape, and the
 * IngestResult vocabulary stay in one place.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CaptureInput, captureThought } from "@/lib/capture";
import { relevanceGate } from "@/lib/relevance-gate";
import { passesPrefilter, type Turn } from "./transcript-prefilter";

export type GateUsage = { inputTokens: number; outputTokens: number };

export type IngestResult = {
	sourceId: string | null;
	/** Whether a (billable) gate call was spent on this turn. */
	gated: boolean;
	usage: GateUsage;
	outcome: "captured" | "duplicate" | "skipped" | "error";
	/** Skip reason or error message. */
	reason?: string;
};

const NO_USAGE: GateUsage = { inputTokens: 0, outputTokens: 0 };

export type CaptureWriter = (input: CaptureInput) => Promise<{ duplicate: boolean }>;

/**
 * Compounding side effects (topic pages, entity linking, person upserts)
 * that captureThought floats via its `background` callback. Under Next.js
 * `after()` keeps them alive; a Bun script exits and kills them mid-flight,
 * so callers must queue them here and `await flushBackground()` before exit.
 */
const backgroundQueue: Promise<unknown>[] = [];

/**
 * Calls the shared capture pipeline directly on a service-role client,
 * queuing its background work instead of losing it to process exit.
 */
export const directWriter: CaptureWriter = async (input) => {
	const result = await captureThought(input, (work) => {
		backgroundQueue.push(
			work.catch((e) => {
				console.error("[ingest] background side effect failed:", e);
				logIngestError(input.source_id ?? null, `background: ${(e as Error).message}`);
			}),
		);
	});
	return { duplicate: result.kind === "duplicate" };
};

/** Awaits all queued background work. Callers must run this before exiting. */
export async function flushBackground(): Promise<void> {
	while (backgroundQueue.length > 0) {
		const batch = backgroundQueue.splice(0, backgroundQueue.length);
		await Promise.allSettled(batch);
	}
}

process.on("exit", () => {
	if (backgroundQueue.length > 0) {
		console.error(
			`[ingest] ${backgroundQueue.length} background task(s) still pending at exit — did the caller forget to await flushBackground()?`,
		);
	}
});

function errorLogDir(): string {
	return process.env.ECHO_LOG_DIR || join(homedir(), "Library", "Logs", "echo");
}

/**
 * Appends a one-line JSON record of a capture failure so outages are
 * visible instead of silently swallowed. Never throws — logging must not
 * itself change control flow.
 */
function logIngestError(sourceId: string | null, reason: string): void {
	try {
		const dir = errorLogDir();
		mkdirSync(dir, { recursive: true });
		const line = JSON.stringify({ ts: new Date().toISOString(), sourceId, reason });
		appendFileSync(join(dir, "ingest.err.log"), `${line}\n`);
	} catch {
		// Logging must never itself throw or change control flow.
	}
}

export type RawCaptureInput = {
	content: string;
	/** Idempotency key — capture is skipped if a thought with it already exists. */
	sourceId: string;
	/** Source taxonomy label, e.g. "claude-precompact". */
	sourceKind: string;
	type?: string;
	topics?: string[];
	memoryType?: string;
	/** Natural expiration; the thought drops out of search after it. */
	expiresAt?: string;
};

/**
 * Raw ingestion entry — captures a pre-composed thought that has already
 * decided it's worth keeping, bypassing the relevance gate. Shares the
 * idempotent capture and the IngestResult vocabulary with ingestTurn; never
 * throws, so hooks can switch on the same outcomes.
 */
export async function ingestRaw(
	input: RawCaptureInput,
	opts: { writer?: CaptureWriter } = {},
): Promise<IngestResult> {
	const writer = opts.writer ?? directWriter;
	try {
		const { duplicate } = await writer({
			content: input.content,
			source_id: input.sourceId,
			source_kind: input.sourceKind,
			...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
			type: input.type,
			topics: input.topics,
			memory_type: input.memoryType,
		});
		return {
			sourceId: input.sourceId,
			gated: false,
			usage: NO_USAGE,
			outcome: duplicate ? "duplicate" : "captured",
		};
	} catch (err) {
		const reason = (err as Error).message;
		logIngestError(input.sourceId, reason);
		return {
			sourceId: input.sourceId,
			gated: false,
			usage: NO_USAGE,
			outcome: "error",
			reason,
		};
	}
}

export async function ingestTurn(
	turn: Turn,
	opts: { projectName?: string; sessionId?: string; writer?: CaptureWriter } = {},
): Promise<IngestResult> {
	if (!passesPrefilter(turn)) {
		return {
			sourceId: null,
			gated: false,
			usage: NO_USAGE,
			outcome: "skipped",
			reason: "prefilter",
		};
	}

	const sessionId = opts.sessionId ?? turn.sessionId;
	if (!sessionId) {
		return {
			sourceId: null,
			gated: false,
			usage: NO_USAGE,
			outcome: "skipped",
			reason: "no session id",
		};
	}

	const sourceId = `${sessionId}:${turn.turnIndex}`;
	const writer = opts.writer ?? directWriter;

	const { decision, usage } = await relevanceGate({
		userMessage: turn.userMessage,
		assistantMessage: turn.assistantMessage,
		projectName: opts.projectName,
	});

	if (!decision.should_capture) {
		return {
			sourceId,
			gated: true,
			usage,
			outcome: "skipped",
			reason: decision.reason || "not relevant",
		};
	}

	try {
		const { duplicate } = await writer({
			content: decision.content,
			source_id: sourceId,
			source_kind: "claude-transcript",
			type: decision.suggested_type,
			topics: decision.suggested_topics,
			memory_type: decision.memory_type,
		});
		return { sourceId, gated: true, usage, outcome: duplicate ? "duplicate" : "captured" };
	} catch (err) {
		const reason = (err as Error).message;
		logIngestError(sourceId, reason);
		return {
			sourceId,
			gated: true,
			usage,
			outcome: "error",
			reason,
		};
	}
}

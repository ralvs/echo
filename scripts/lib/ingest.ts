/**
 * Transcript ingestion — the one workflow that turns a Claude Code
 * user→assistant turn into an Echo thought: cheap prefilter, Haiku
 * relevance gate, then an idempotent POST to /api/thoughts.
 *
 * The Stop hook (last turn), catch-up (whole sessions), and the mine CLI
 * (history with budget) are adapters that differ only in which turns they
 * feed in and what policy they wrap around the calls.
 */

import { relevanceGate } from "@/lib/relevance-gate";
import { passesPrefilter, type Turn } from "./transcript-prefilter";

const ECHO_API_URL = process.env.ECHO_API_URL ?? "http://localhost:3000";

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

/**
 * POSTs a capture to Echo. Throws on HTTP failure; reports whether the
 * server deduplicated it by source_id.
 */
export async function postCapture(body: Record<string, unknown>): Promise<{ duplicate: boolean }> {
	const res = await fetch(`${ECHO_API_URL}/api/thoughts`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`POST /api/thoughts failed (${res.status}): ${text.slice(0, 300)}`);
	}
	const json = (await res.json().catch(() => ({}))) as { skipped?: string };
	return { duplicate: json.skipped === "duplicate" };
}

export async function ingestTurn(
	turn: Turn,
	opts: { projectName?: string; sessionId?: string } = {},
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
		const { duplicate } = await postCapture({
			content: decision.content,
			source_id: sourceId,
			source_kind: "claude-transcript",
			metadata: {
				type: decision.suggested_type,
				topics: decision.suggested_topics,
				memory_type: decision.memory_type,
			},
		});
		return { sourceId, gated: true, usage, outcome: duplicate ? "duplicate" : "captured" };
	} catch (err) {
		return {
			sourceId,
			gated: true,
			usage,
			outcome: "error",
			reason: (err as Error).message,
		};
	}
}

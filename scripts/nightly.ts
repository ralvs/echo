#!/usr/bin/env bun
/**
 * Echo nightly — the launchd entry point. Runs two legs against a single
 * scan window: catch-up (scan recent Claude Code and Grok CLI sessions
 * across ingestable personal projects, push new turns through the shared
 * capture pipeline) and then dream (auto-apply safe maintenance fixes,
 * propose memory changes, persist the report). Appends a one-line summary
 * per leg to the dream log.
 *
 * Ordering is deliberate: dream must run after catch-up (and after
 * catch-up's background work is flushed) so it diffs against a corpus that
 * already contains last night's turns — otherwise it would propose memories
 * the ingest path should have already created.
 *
 * Usage: bun run nightly   (== bun run scripts/nightly.ts)
 * Must run from the echo project root (so Bun loads .env.local).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AppliedFix,
	applySafeFixes,
	type DreamInput,
	type DreamTurn,
	dream,
	findSafeFixes,
	listRecentFingerprints,
	writeDreamReport,
} from "@shared/dream.ts";
import { nodeAi } from "@/lib/model";
import { createServiceClient } from "@/lib/supabase";
import { flushBackground, ingestTurn } from "@/scripts/lib/ingest";
import { type ScannedTurn, scanWindow } from "@/scripts/lib/transcript-scan";

const CATCH_UP_WINDOW_HOURS = 30;
// Matches scripts/dream.ts's suppression window: a proposal the Owner
// rejected in the last 30 days doesn't resurface on the next nightly run.
const FINGERPRINT_SUPPRESSION_DAYS = 30;
const REQUIRED_ENV_VARS = [
	"SUPABASE_SERVICE_ROLE_KEY",
	"AI_GATEWAY_API_KEY",
	"NEXT_PUBLIC_SUPABASE_URL",
] as const;

function assertRequiredEnv(): void {
	const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
	if (missing.length > 0) {
		console.error(
			`[echo-nightly] missing required env var(s): ${missing.join(", ")} — aborting rather than half-running`,
		);
		process.exit(1);
	}
}

function logDir(): string {
	return process.env.ECHO_LOG_DIR || join(homedir(), "Library", "Logs", "echo");
}

function appendDreamLog(record: Record<string, unknown>): void {
	try {
		const dir = logDir();
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "dream.jsonl"), `${JSON.stringify(record)}\n`);
	} catch (err) {
		console.error(`[echo-nightly] failed to write dream log: ${(err as Error).message}`);
	}
}

type CatchUpResult = { scanned: number; captured: number; skipped: number; errors: number };

async function runCatchUpLeg(turns: ScannedTurn[]): Promise<CatchUpResult> {
	const result: CatchUpResult = { scanned: turns.length, captured: 0, skipped: 0, errors: 0 };

	for (const turn of turns) {
		const outcome = await ingestTurn(turn, {
			projectName: turn.projectName,
			sourceId: turn.source === "grok" ? `grok:${turn.sessionId}:${turn.turnIndex}` : undefined,
			sourceKind: turn.source === "grok" ? "grok-transcript" : undefined,
		});

		switch (outcome.outcome) {
			case "captured":
				result.captured++;
				break;
			case "duplicate":
			case "skipped":
				result.skipped++;
				break;
			case "error":
				console.error(`[echo-nightly] error on ${outcome.sourceId}: ${outcome.reason}`);
				result.errors++;
				break;
		}
	}

	// Mandatory before this leg is considered done: under Bun (unlike
	// Next.js's after()), nothing keeps a floated background promise alive
	// past process exit — see scripts/lib/ingest.ts.
	await flushBackground();
	return result;
}

/** Maps ScannedTurn (Claude + Grok, unified) onto the DreamTurn shape
 * dream() expects — same mapping scripts/dream.ts's CLI uses. */
function toDreamTurns(turns: ScannedTurn[]): DreamTurn[] {
	return turns.map((t) => ({
		sessionId: t.sessionId,
		turnIndex: t.turnIndex,
		userMessage: t.userMessage,
		assistantMessage: t.assistantMessage,
		projectName: t.projectName,
		at: t.timestamp,
		transcriptPath: t.transcriptPath,
	}));
}

type DreamLegResult = {
	scanned: number;
	safeFixesFound: number;
	safeFixesApplied: number;
	proposals: number;
	reportId?: string;
	duplicate?: boolean;
};

/**
 * The dream leg: auto-applies safe maintenance fixes, then reads the same
 * scan window's turns to propose memory changes, and persists the report —
 * recording the applied fixes in metadata.dream.auto_applied so the report
 * itself shows what the nightly job did on its own versus what it's asking
 * the Owner to review.
 */
async function runDreamLeg(turns: ScannedTurn[], now: Date): Promise<DreamLegResult> {
	const db = createServiceClient();
	const deps = { db, ai: nodeAi, ownerName: process.env.ECHO_OWNER_NAME ?? null };

	const fixes = await findSafeFixes(deps);
	const applied: AppliedFix[] = await applySafeFixes(deps, fixes);

	const suppressFingerprints = await listRecentFingerprints(db, FINGERPRINT_SUPPRESSION_DAYS);
	const input: DreamInput = {
		turns: toDreamTurns(turns),
		window: {
			from: new Date(now.getTime() - CATCH_UP_WINDOW_HOURS * 60 * 60 * 1000).toISOString(),
			to: now.toISOString(),
		},
		now,
		suppressFingerprints,
	};

	const result = await dream(deps, input);

	// Scheduled/nightly source_id scheme: date only (no minutes), so a
	// second nightly run the same day is a no-op duplicate rather than a
	// second report — see writeDreamReport's idempotency on source_id, and
	// scripts/dream.ts's manual-run scheme for the ad-hoc counterpart.
	const sourceId = `dream:${now.toISOString().slice(0, 10)}`;
	const { id, duplicate } = await writeDreamReport(deps, result, sourceId, applied);

	return {
		scanned: result.scanned.turns,
		safeFixesFound: fixes.length,
		safeFixesApplied: applied.filter((a) => a.status === "applied").length,
		proposals: result.proposals.length,
		reportId: id,
		duplicate,
	};
}

async function main() {
	assertRequiredEnv();

	const startedAt = new Date();
	const startedAtIso = startedAt.toISOString();
	console.log(`[echo-nightly] catch-up leg starting, window ${CATCH_UP_WINDOW_HOURS}h`);

	const turns = scanWindow(CATCH_UP_WINDOW_HOURS);

	let catchUp: CatchUpResult;
	let catchUpError: string | undefined;
	try {
		catchUp = await runCatchUpLeg(turns);
	} catch (err) {
		catchUpError = (err as Error).message;
		catchUp = { scanned: 0, captured: 0, skipped: 0, errors: 1 };
	}

	console.log("[echo-nightly] dream leg starting");
	let dreamLeg: DreamLegResult | undefined;
	let dreamError: string | undefined;
	try {
		dreamLeg = await runDreamLeg(turns, startedAt);
	} catch (err) {
		dreamError = (err as Error).message;
	}

	appendDreamLog({
		ts: startedAtIso,
		leg: "catch-up",
		scanned: catchUp.scanned,
		captured: catchUp.captured,
		skipped: catchUp.skipped,
		errors: catchUp.errors,
		...(catchUpError ? { error: catchUpError } : {}),
	});

	appendDreamLog({
		ts: startedAtIso,
		leg: "dream",
		...(dreamLeg ?? {}),
		...(dreamError ? { error: dreamError } : {}),
	});

	console.log(
		`[echo-nightly] catch-up done — scanned ${catchUp.scanned}, captured ${catchUp.captured}, ` +
			`skipped ${catchUp.skipped}, errors ${catchUp.errors}`,
	);
	if (dreamLeg) {
		console.log(
			`[echo-nightly] dream done — ${dreamLeg.safeFixesApplied}/${dreamLeg.safeFixesFound} safe fix(es) applied, ` +
				`${dreamLeg.proposals} proposal(s), report ${dreamLeg.reportId ?? "(none)"}` +
				`${dreamLeg.duplicate ? " (duplicate — already existed)" : ""}`,
		);
	}

	if (catchUpError) console.error(`[echo-nightly] catch-up leg failed: ${catchUpError}`);
	if (dreamError) console.error(`[echo-nightly] dream leg failed: ${dreamError}`);
	if (catchUpError || dreamError) process.exit(1);
}

main().catch((err) => {
	console.error(`[echo-nightly] unexpected error: ${(err as Error).message}`);
	process.exit(1);
});

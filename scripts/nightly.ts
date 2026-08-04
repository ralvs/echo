#!/usr/bin/env bun
/**
 * Echo nightly — the launchd entry point. Runs the catch-up leg: scan
 * recent Claude Code and Grok CLI sessions across ingestable (personal)
 * projects, push new turns through the shared capture pipeline, and append
 * a one-line summary to the dream log.
 *
 * Usage: bun run nightly   (== bun run scripts/nightly.ts)
 * Must run from the echo project root (so Bun loads .env.local).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { flushBackground, ingestTurn } from "@/scripts/lib/ingest";
import { type ScannedTurn, scanWindow } from "@/scripts/lib/transcript-scan";

const CATCH_UP_WINDOW_HOURS = 30;
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

async function runCatchUpLeg(): Promise<CatchUpResult> {
	const turns: ScannedTurn[] = scanWindow(CATCH_UP_WINDOW_HOURS);
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

	await flushBackground();
	return result;
}

async function main() {
	assertRequiredEnv();

	const startedAt = new Date().toISOString();
	console.log(`[echo-nightly] catch-up leg starting, window ${CATCH_UP_WINDOW_HOURS}h`);

	let catchUp: CatchUpResult;
	let error: string | undefined;
	try {
		catchUp = await runCatchUpLeg();
	} catch (err) {
		error = (err as Error).message;
		catchUp = { scanned: 0, captured: 0, skipped: 0, errors: 1 };
	}

	// TODO(phase-4): dream leg runs here, after the catch-up leg

	appendDreamLog({
		ts: startedAt,
		leg: "catch-up",
		scanned: catchUp.scanned,
		captured: catchUp.captured,
		skipped: catchUp.skipped,
		errors: catchUp.errors,
		...(error ? { error } : {}),
	});

	console.log(
		`[echo-nightly] done — scanned ${catchUp.scanned}, captured ${catchUp.captured}, skipped ${catchUp.skipped}, errors ${catchUp.errors}`,
	);

	if (error) {
		console.error(`[echo-nightly] catch-up leg failed: ${error}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`[echo-nightly] unexpected error: ${(err as Error).message}`);
	process.exit(1);
});

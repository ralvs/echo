#!/usr/bin/env bun
/**
 * Echo catch-up processor — scans recent Claude Code and Grok CLI sessions
 * (via scripts/lib/transcript-scan.ts) and pushes any unprocessed turns
 * through the shared ingestion workflow. Safe to re-run: Echo deduplicates
 * by source_id so the same turn is never captured twice.
 *
 * Usage:
 *   bun run scripts/claude-hooks/catch-up.ts [--hours N] [--file path]
 *
 * --hours N     Scan sessions modified in the last N hours (default: 48)
 * --file path   Process a single Claude Code transcript file instead of
 *               scanning the window
 *
 * Must be run from the echo project root (so Bun loads .env.local).
 */

import { flushBackground, ingestTurn } from "@/scripts/lib/ingest";
import { type ScannedTurn, scanClaudeFile, scanWindow } from "@/scripts/lib/transcript-scan";

function parseArgs(): { hours: number; file?: string } {
	const args = process.argv.slice(2);
	let hours = 48;
	let file: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--hours" && args[i + 1]) hours = Number(args[++i]);
		if (args[i] === "--file" && args[i + 1]) file = args[++i];
	}
	return { hours, file };
}

async function processTurns(
	turns: ScannedTurn[],
): Promise<{ captured: number; skipped: number; errors: number }> {
	const stats = { captured: 0, skipped: 0, errors: 0 };

	for (const turn of turns) {
		const result = await ingestTurn(turn, {
			projectName: turn.projectName,
			sourceId: turn.source === "grok" ? `grok:${turn.sessionId}:${turn.turnIndex}` : undefined,
			sourceKind: turn.source === "grok" ? "grok-transcript" : undefined,
		});

		switch (result.outcome) {
			case "captured":
				console.log(`[echo-catchup] captured ${result.sourceId}`);
				stats.captured++;
				break;
			case "duplicate":
			case "skipped":
				stats.skipped++;
				break;
			case "error":
				console.error(`[echo-catchup] error on ${result.sourceId}: ${result.reason}`);
				stats.errors++;
				break;
		}
	}

	return stats;
}

async function main() {
	const { hours, file } = parseArgs();

	let turns: ScannedTurn[];
	if (file) {
		console.log(`[echo-catchup] processing single file: ${file}`);
		turns = scanClaudeFile(file);
	} else {
		turns = scanWindow(hours);
		console.log(
			`[echo-catchup] found ${turns.length} turn(s) in sessions modified in the last ${hours}h`,
		);
	}

	const { captured, skipped, errors } = await processTurns(turns);

	console.log(
		`[echo-catchup] done — captured: ${captured}, skipped: ${skipped}, errors: ${errors}`,
	);

	await flushBackground();
}

main().catch((err) => {
	console.error(`[echo-catchup] unexpected error: ${(err as Error).message}`);
	process.exit(1);
});

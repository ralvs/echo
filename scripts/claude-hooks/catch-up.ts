#!/usr/bin/env bun
/**
 * Echo catch-up processor — scans recent Claude Code transcript files and
 * pushes any unprocessed turns through the shared ingestion workflow.
 * Safe to re-run: Echo deduplicates by source_id so the same turn is never
 * captured twice.
 *
 * Usage:
 *   bun run scripts/claude-hooks/catch-up.ts [--hours N] [--file path]
 *
 * --hours N     Scan transcripts modified in the last N hours (default: 48)
 * --file path   Process a single transcript file instead of scanning
 *
 * Must be run from the echo project root (so Bun loads .env.local).
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ingestTurn } from "@/scripts/lib/ingest";
import { pairTurns, parseTranscript } from "@/scripts/lib/transcript-prefilter";

const PROJECTS_ROOT = join(homedir(), ".claude", "projects");

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

function findRecentTranscripts(sinceMs: number): string[] {
	const results: string[] = [];
	let projectDirs: string[];
	try {
		projectDirs = readdirSync(PROJECTS_ROOT);
	} catch {
		console.error(`[echo-catchup] cannot read ${PROJECTS_ROOT}`);
		return [];
	}
	for (const dir of projectDirs) {
		const projectPath = join(PROJECTS_ROOT, dir);
		try {
			const files = readdirSync(projectPath);
			for (const f of files) {
				if (!f.endsWith(".jsonl")) continue;
				const filePath = join(projectPath, f);
				try {
					const stat = statSync(filePath);
					if (stat.mtimeMs >= sinceMs) results.push(filePath);
				} catch {
					// skip unreadable files
				}
			}
		} catch {
			// skip unreadable project dirs
		}
	}
	return results;
}

function projectNameFromPath(transcriptPath: string): string | undefined {
	// ~/.claude/projects/<project-dir>/<session>.jsonl
	const parts = transcriptPath.split("/");
	const projectsIdx = parts.lastIndexOf("projects");
	if (projectsIdx >= 0 && parts[projectsIdx + 1]) {
		// Convert "-Volumes-stuff-renan-foo" → "foo"
		const encoded = parts[projectsIdx + 1];
		const segments = encoded.split("-").filter(Boolean);
		return segments[segments.length - 1] || encoded;
	}
	return undefined;
}

async function processTranscript(
	filePath: string,
): Promise<{ captured: number; skipped: number; errors: number }> {
	const stats = { captured: 0, skipped: 0, errors: 0 };
	let messages: ReturnType<typeof parseTranscript>;
	try {
		messages = parseTranscript(filePath);
	} catch (err) {
		console.error(`[echo-catchup] failed to parse ${filePath}: ${(err as Error).message}`);
		stats.errors++;
		return stats;
	}

	const turns = pairTurns(messages);
	if (turns.length === 0) return stats;

	const projectName = projectNameFromPath(filePath);

	for (const turn of turns) {
		const result = await ingestTurn(turn, { projectName });

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

	let transcripts: string[];
	if (file) {
		transcripts = [file];
		console.log(`[echo-catchup] processing single file: ${file}`);
	} else {
		const sinceMs = Date.now() - hours * 60 * 60 * 1000;
		transcripts = findRecentTranscripts(sinceMs);
		console.log(
			`[echo-catchup] found ${transcripts.length} transcript(s) modified in the last ${hours}h`,
		);
	}

	let totalCaptured = 0;
	let totalSkipped = 0;
	let totalErrors = 0;

	for (const path of transcripts) {
		const { captured, skipped, errors } = await processTranscript(path);
		totalCaptured += captured;
		totalSkipped += skipped;
		totalErrors += errors;
	}

	console.log(
		`[echo-catchup] done — captured: ${totalCaptured}, skipped: ${totalSkipped}, errors: ${totalErrors}`,
	);
}

main().catch((err) => {
	console.error(`[echo-catchup] unexpected error: ${(err as Error).message}`);
	process.exit(1);
});

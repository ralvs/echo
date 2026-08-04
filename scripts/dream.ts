#!/usr/bin/env bun
/**
 * The dream CLI — thin Bun adapter over the shared dream() workflow
 * (supabase/functions/_shared/dream.ts). Reads the day's Claude Code
 * transcripts, grounds them against the corpus, and prints a numbered list
 * of proposed memory changes with transcript quotes as evidence.
 *
 *   bun run scripts/dream.ts [--hours 30] [--dry-run] [--max-usd 0.50]
 *                            [--max-proposals 12] [--checks stale,duplicates]
 *                            [--force] [--file <path>]
 *
 * Phase 3: --dry-run is the only supported mode. The write path
 * (writeDreamReport) is intentionally unreachable from this CLI — approving
 * and applying proposals lands in a later phase.
 *
 * Turns are sourced from scanWindow() (scripts/lib/transcript-scan.ts), the
 * same scope-guarded, prefiltered seam catch-up.ts and nightly.ts use — or
 * from --file for a caller-supplied JSON array of DreamTurn.
 */

import { readFileSync } from "node:fs";
import {
	type DreamInput,
	type DreamProposal,
	type DreamTurn,
	dream,
	listRecentFingerprints,
} from "@shared/dream.ts";
import type { LintCheck } from "@shared/lint.ts";
import type { ModelUsage } from "@shared/model.ts";
import { nodeAi } from "@/lib/model";
import { createServiceClient } from "@/lib/supabase";
import { CostTracker } from "@/scripts/lib/cost-tracker";
import { scanWindow } from "@/scripts/lib/transcript-scan.ts";

const VALID_CHECKS: LintCheck[] = ["contradictions", "orphans", "stale", "duplicates"];

type Args = {
	hours: number;
	dryRun: boolean;
	maxUsd: number;
	maxProposals: number;
	checks: LintCheck[];
	force: boolean;
	file?: string;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		hours: 30,
		dryRun: false,
		maxUsd: 0.5,
		maxProposals: 12,
		checks: ["stale", "duplicates"],
		force: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--hours") args.hours = Number(argv[++i]);
		else if (a === "--dry-run") args.dryRun = true;
		else if (a === "--max-usd") args.maxUsd = Number(argv[++i]);
		else if (a === "--max-proposals") args.maxProposals = Number(argv[++i]);
		else if (a === "--force") args.force = true;
		else if (a === "--file") args.file = argv[++i];
		else if (a === "--checks") {
			const raw = (argv[++i] ?? "").split(",").map((s) => s.trim()) as LintCheck[];
			const invalid = raw.filter((c) => !VALID_CHECKS.includes(c));
			if (invalid.length) {
				console.error(`Unknown check(s): ${invalid.join(", ")}. Valid: ${VALID_CHECKS.join(", ")}`);
				process.exit(2);
			}
			args.checks = raw;
		} else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		} else {
			console.error(`Unknown flag: ${a}`);
			printHelp();
			process.exit(2);
		}
	}
	return args;
}

function printHelp() {
	console.log(`dream — nightly memory-change proposals from recent transcripts

Usage:
  bun run scripts/dream.ts [flags]

Flags:
  --hours <N>            Scan transcripts from the last N hours (default 30).
  --dry-run              Only supported mode in this phase. writeDreamReport is never called.
  --max-usd <N>          Cap classifier spend per run (default 0.50).
  --max-proposals <N>    Cap the number of proposals returned (default 12).
  --checks <list>        Comma-separated lint checks (default stale,duplicates).
                          Valid: ${VALID_CHECKS.join(", ")}
  --force                Skip fingerprint suppression (re-propose previously rejected items).
  --file <path>          Read turns from a JSON file (array of DreamTurn) instead of scanning transcripts.
  -h, --help              Show this help.
`);
}

/** Sources turns via scanWindow() — already scope-guarded (personal projects
 * only) and prefiltered before this ever sees turn content. Maps ScannedTurn
 * (Claude + Grok, unified) onto the DreamTurn shape dream() expects. */
function loadTurnsFromTranscripts(hours: number): DreamTurn[] {
	return scanWindow(hours).map((t) => ({
		sessionId: t.sessionId,
		turnIndex: t.turnIndex,
		userMessage: t.userMessage,
		assistantMessage: t.assistantMessage,
		projectName: t.projectName,
		at: t.timestamp,
		transcriptPath: t.transcriptPath,
	}));
}

function loadTurnsFromFile(path: string): DreamTurn[] {
	const raw = readFileSync(path, "utf-8");
	return JSON.parse(raw) as DreamTurn[];
}

function formatProposal(p: DreamProposal): string {
	// Lint-derived proposals (duplicates/stale/contradictions) have no real
	// session/turn — session_id is the sentinel "lint". Printing "(session
	// lint, turn -1)" would be nonsense provenance, so suppress that suffix.
	const provenance =
		p.evidence.session_id === "lint"
			? ""
			: ` (session ${p.evidence.session_id}, turn ${p.evidence.turn_index}, ${p.evidence.at})`;
	const lines = [
		`${p.n}. [${p.category}/${p.action}] confidence ${(p.confidence * 100).toFixed(0)}% — ${p.pid}`,
		`   ${p.proposed_content}`,
		`   targets: ${p.target_ids.length ? p.target_ids.join(", ") : "(none — new memory)"}`,
		`   rationale: ${p.rationale}`,
		`   evidence: "${p.evidence.quote}"${provenance}`,
	];
	return lines.join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (!args.dryRun) {
		console.error(
			"Error: this phase only supports --dry-run. Applying proposals lands in a later phase.",
		);
		process.exit(2);
	}

	const turns = args.file ? loadTurnsFromFile(args.file) : loadTurnsFromTranscripts(args.hours);
	console.log(`Loaded ${turns.length} candidate turns.`);

	const db = createServiceClient();
	const deps = { db, ai: nodeAi, ownerName: process.env.ECHO_OWNER_NAME ?? null };

	const tracker = new CostTracker(args.maxUsd);
	const onUsage = (u: ModelUsage): "continue" | "stop" => {
		tracker.record(u.inputTokens, u.outputTokens);
		return tracker.overBudget() ? "stop" : "continue";
	};

	// --force skips fingerprint suppression: previously-rejected proposals
	// (recorded in dream reports written in the last 14 days) are re-proposed
	// instead of silently dropped.
	const suppressFingerprints = args.force
		? new Set<string>()
		: await listRecentFingerprints(db, 14);

	const now = new Date();
	const input: DreamInput = {
		turns,
		window: {
			from: new Date(now.getTime() - args.hours * 60 * 60 * 1000).toISOString(),
			to: now.toISOString(),
		},
		now,
		maxProposals: args.maxProposals,
		checks: args.checks,
		suppressFingerprints,
		onUsage,
	};

	const result = await dream(deps, input);

	console.log(
		`\nScanned ${result.scanned.turns} turns across ${result.scanned.sessions} sessions. ` +
			`Spent $${tracker.usd.toFixed(4)} (cap $${args.maxUsd.toFixed(2)}).`,
	);
	if (result.health.capture_pipeline_stale) {
		console.log(
			`⚠ Capture pipeline looks stale (newest capture: ${result.health.newest_capture_at ?? "never"}).`,
		);
	}
	if (result.truncated) {
		console.log("⚠ Run truncated early (budget cap hit) — proposals below are partial.");
	}
	if (result.duplicatesRejected > 0) {
		console.log(
			`Duplicate-merge gate rejected ${result.duplicatesRejected} candidate pair(s) (not the same fact, or unconfirmed).`,
		);
	}

	if (!result.proposals.length) {
		console.log("\nNo proposals.");
		return;
	}

	console.log(`\n${result.proposals.length} proposal(s):\n`);
	for (const p of result.proposals) {
		console.log(formatProposal(p));
		console.log("");
	}

	console.log(
		"Dry run only — no dream report was written. Re-run without this phase's limits once",
	);
	console.log("apply/reject support lands to persist and act on these proposals.");
}

main().catch((err) => {
	console.error(`Dream failed: ${(err as Error).stack ?? (err as Error).message}`);
	process.exit(1);
});

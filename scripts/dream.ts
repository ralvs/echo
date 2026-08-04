#!/usr/bin/env bun
/**
 * The dream CLI — thin Bun adapter over the shared dream() workflow
 * (supabase/functions/_shared/dream.ts). Reads the day's Claude Code
 * transcripts, grounds them against the corpus, prints a numbered list of
 * proposed memory changes with transcript quotes as evidence, and — unless
 * --dry-run is passed — persists the report via writeDreamReport.
 *
 *   bun run scripts/dream.ts [--hours 30] [--dry-run] [--max-usd 0.50]
 *                            [--max-proposals 12] [--checks stale,duplicates]
 *                            [--force] [--file <path>]
 *
 * This is always the *manual* run: source_id is `dream:<date>T<HHmm>`, so an
 * ad-hoc run here never collides with the nightly job's `dream:<date>`
 * report (scripts/nightly.ts writes that one directly, not through this
 * CLI). Writing is idempotent on source_id — a second run in the same
 * minute reports "already exists" rather than silently doing nothing twice.
 *
 * Turns are sourced from scanWindow() (scripts/lib/transcript-scan.ts), the
 * same scope-guarded, prefiltered seam catch-up.ts and nightly.ts use — or
 * from --file for a caller-supplied JSON array of DreamTurn.
 */

import { readFileSync } from "node:fs";
import {
	type DreamInput,
	type DreamProposal,
	type DreamResult,
	type DreamTurn,
	dream,
	listRecentFingerprints,
	writeDreamReport,
} from "@shared/dream.ts";
import type { LintCheck } from "@shared/lint.ts";
import type { Ai, ModelUsage } from "@shared/model.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nodeAi } from "@/lib/model";
import { createServiceClient } from "@/lib/supabase";
import { CostTracker } from "@/scripts/lib/cost-tracker";
import { scanWindow } from "@/scripts/lib/transcript-scan.ts";

const VALID_CHECKS: LintCheck[] = ["contradictions", "orphans", "stale", "duplicates"];
// Rejections suppress for 30 days — long enough that a proposal the Owner
// already turned down doesn't keep resurfacing on every subsequent run.
const FINGERPRINT_SUPPRESSION_DAYS = 30;

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
  --dry-run              Print proposals without writing a dream report (default: write).
  --max-usd <N>          Cap classifier spend per run (default 0.50).
  --max-proposals <N>    Cap the number of proposals returned (default 12).
  --checks <list>        Comma-separated lint checks (default stale,duplicates).
                          Valid: ${VALID_CHECKS.join(", ")}
  --force                Skip fingerprint suppression (re-propose previously rejected items),
                          and if a report already exists for this run, write a new revision
                          under a ":r<n>" suffixed source_id instead of reporting a duplicate.
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

/** `dream:<YYYY-MM-DD>T<HHmm>` — this CLI is always a manual/ad-hoc run, so
 * it embeds minutes to stay distinct from the nightly job's `dream:<date>`
 * report (see module docstring). */
function manualSourceId(now: Date): string {
	const date = now.toISOString().slice(0, 10);
	const hhmm = now.toISOString().slice(11, 16).replace(":", "");
	return `dream:${date}T${hhmm}`;
}

async function sourceIdExists(db: SupabaseClient, sourceId: string): Promise<boolean> {
	const { data } = await db.from("thoughts").select("id").eq("source_id", sourceId).limit(1);
	return ((data ?? []) as unknown[]).length > 0;
}

/** Resolves the source_id to write under. Without --force this is just the
 * plain manual id (a collision surfaces as writeDreamReport's normal
 * `duplicate: true`). With --force, a colliding id gets a ":r<n>" suffix so
 * a deliberate re-run of the same run actually writes a new report instead
 * of being swallowed as a duplicate. */
async function resolveSourceId(db: SupabaseClient, now: Date, force: boolean): Promise<string> {
	const base = manualSourceId(now);
	if (!force) return base;

	let candidate = base;
	let n = 2;
	while (await sourceIdExists(db, candidate)) {
		candidate = `${base}:r${n}`;
		n++;
	}
	return candidate;
}

export type RunOutcome = {
	result: DreamResult;
	write: { sourceId: string; id: string; duplicate: boolean } | null;
};

/**
 * The testable core: runs dream() against the given deps/input, then either
 * skips the write (dry run) or resolves a source_id and persists via
 * writeDreamReport. Kept separate from main() so tests can inject a fake db
 * without going through argv parsing or the real Supabase client.
 */
export async function runDream(
	deps: { db: SupabaseClient; ai: Ai; ownerName?: string | null },
	input: DreamInput,
	opts: { dryRun: boolean; force: boolean },
): Promise<RunOutcome> {
	const result = await dream(deps, input);
	if (opts.dryRun) return { result, write: null };

	const sourceId = await resolveSourceId(deps.db, input.now ?? new Date(), opts.force);
	const { id, duplicate } = await writeDreamReport(deps, result, sourceId);
	return { result, write: { sourceId, id, duplicate } };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

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
	// (recorded in dream reports written in the last 30 days) are re-proposed
	// instead of silently dropped.
	const suppressFingerprints = args.force
		? new Set<string>()
		: await listRecentFingerprints(db, FINGERPRINT_SUPPRESSION_DAYS);

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

	const { result, write } = await runDream(deps, input, { dryRun: args.dryRun, force: args.force });

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
	} else {
		console.log(`\n${result.proposals.length} proposal(s):\n`);
		for (const p of result.proposals) {
			console.log(formatProposal(p));
			console.log("");
		}
	}

	if (!write) {
		console.log("Dry run — no dream report was written.");
	} else if (write.duplicate) {
		console.log(
			`Dream report already exists for ${write.sourceId} (id ${write.id}) — not written again. ` +
				"Pass --force to write a new revision.",
		);
	} else {
		console.log(`Wrote dream report ${write.id} (source_id ${write.sourceId}).`);
	}
}

// Guarded so importing runDream/resolveSourceId from a test (run under
// Vitest/Node, where import.meta.main is unset) never triggers a real run
// against createServiceClient(). True only when Bun loads this file as the
// process entrypoint (`bun run scripts/dream.ts`).
if (import.meta.main) {
	main().catch((err) => {
		console.error(`Dream failed: ${(err as Error).stack ?? (err as Error).message}`);
		process.exit(1);
	});
}

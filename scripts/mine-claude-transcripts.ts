#!/usr/bin/env bun
/**
 * Mine Claude Code transcripts into Echo thoughts.
 *
 * Cost-safe: scans project directories under ~/.claude/projects/, restricts
 * to ingestable (personal) sessions via isIngestable (scripts/lib/ingest-scope.ts),
 * applies a cheap regex pre-filter, runs each surviving turn through a Haiku
 * relevance gate, and POSTs gate-positive captures to /api/thoughts. Stops
 * gracefully when either the per-batch turn cap or USD cap is hit.
 * Resume-safe via a checkpoint file keyed by (project, sessionId, turnIndex).
 *
 * The scope guard (isIngestable) is applied per-session-file, before that
 * file's content is parsed — see listSessionsForProject below. This replaces
 * the former hardcoded project allowlist: a paper trail is no longer needed
 * because scope is now enforced by cwd, not by editing a committed list.
 *
 * The user runs this command. This script never auto-runs.
 *
 * Examples:
 *   bun run scripts/mine-claude-transcripts.ts --dry-run
 *   bun run scripts/mine-claude-transcripts.ts --project quantic --batch-size 250
 *   bun run scripts/mine-claude-transcripts.ts --project echo --max-cost-usd 3
 *   bun run scripts/mine-claude-transcripts.ts --project worthscene --reset-checkpoint
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CostTracker } from "@/scripts/lib/cost-tracker";
import { flushBackground, ingestTurn } from "@/scripts/lib/ingest";
import { isIngestable } from "@/scripts/lib/ingest-scope";
import {
	emptyState,
	lastTurnFor,
	loadState,
	type MineState,
	resetCheckpoint,
	saveState,
	setLastTurnFor,
	statePath,
} from "@/scripts/lib/mine-state";
import { progressFilePath, writeProgress } from "@/scripts/lib/progress-file";
import { pairTurns, parseTranscript, passesPrefilter } from "@/scripts/lib/transcript-prefilter";
import { readTranscriptCwd } from "@/scripts/lib/transcript-scan";

const PROJECTS_ROOT = `${homedir()}/.claude/projects`;

/** Convenience aliases for --project; not a security boundary — isIngestable is. */
const PROJECT_ALIASES: Record<string, string> = {
	echo: "-Volumes-stuff-renan-echo",
	worthscene: "-Volumes-stuff-renan-worthscene",
	ora: "-Volumes-stuff-ora",
	quantic: "-Volumes-stuff-renan-quantic",
};

function listProjectDirs(): string[] {
	try {
		return readdirSync(PROJECTS_ROOT).filter((d) => {
			try {
				return statSync(join(PROJECTS_ROOT, d)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch (err) {
		console.error(`Cannot read ${PROJECTS_ROOT}: ${(err as Error).message}`);
		return [];
	}
}

/** Resolves a --project value (alias or literal dir name) to a dir that exists. */
function resolveProjectDir(name: string): string | null {
	const candidate = PROJECT_ALIASES[name] ?? name;
	return listProjectDirs().includes(candidate) ? candidate : null;
}

type Args = {
	dryRun: boolean;
	project?: string;
	batchSize: number;
	maxCostUsd: number;
	resetCheckpoint: boolean;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		dryRun: false,
		batchSize: 250,
		maxCostUsd: 1.5,
		resetCheckpoint: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") args.dryRun = true;
		else if (a === "--reset-checkpoint") args.resetCheckpoint = true;
		else if (a === "--batch-size") args.batchSize = Number(argv[++i]);
		else if (a === "--max-cost-usd") args.maxCostUsd = Number(argv[++i]);
		else if (a === "--project") {
			const name = argv[++i];
			const resolved = resolveProjectDir(name);
			if (!resolved) {
				console.error(
					`Error: project "${name}" not found under ~/.claude/projects/. Known: ${listProjectDirs().join(", ")}`,
				);
				process.exit(2);
			}
			args.project = resolved;
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
	console.log(`mine-claude-transcripts — backfill Echo from Claude Code transcripts

Usage:
  bun run scripts/mine-claude-transcripts.ts [flags]

Flags:
  --dry-run                Measure exposure, plan batches, write progress file. Zero API spend.
  --project <name>         Required when not dry-run. A ~/.claude/projects/ dir name, or one of
                            these aliases: ${Object.keys(PROJECT_ALIASES).join(", ")}
  --batch-size <N>         Cap gate calls per run (default 250).
  --max-cost-usd <N>       Cap USD spend per run (default 1.5).
  --reset-checkpoint       Clear checkpoint for the chosen project before running.
  -h, --help               Show this help.

State files:
  ${statePath()}
  ${progressFilePath()}
`);
}

/**
 * Lists session files for a project, restricted to ingestable (personal)
 * sessions. The scope guard runs against each file's leading `cwd` field —
 * before parseTranscript reads the rest of the file's content.
 */
function listSessionsForProject(project: string): string[] {
	const dir = join(PROJECTS_ROOT, project);
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(dir, f));
	} catch (err) {
		console.error(`Project dir missing: ${dir} (${(err as Error).message})`);
		return [];
	}
	return files.filter((f) => isIngestable(readTranscriptCwd(f)));
}

function measureExposure(): MineState {
	const state = loadState() ?? emptyState();
	for (const project of listProjectDirs()) {
		const files = listSessionsForProject(project);
		let userMsgs = 0;
		let assistantMsgs = 0;
		let turnPairs = 0;
		let prefilteredTurns = 0;
		for (const f of files) {
			const messages = parseTranscript(f);
			for (const m of messages) {
				if (m.type === "user") userMsgs++;
				else if (m.type === "assistant") assistantMsgs++;
			}
			const turns = pairTurns(messages);
			turnPairs += turns.length;
			for (const t of turns) {
				if (passesPrefilter(t)) prefilteredTurns++;
			}
		}
		state.exposure[project] = {
			files: files.length,
			userMsgs,
			assistantMsgs,
			turnPairs,
			prefilteredTurns,
		};
	}
	return state;
}

function planBatches(state: MineState, batchSize: number, maxCostUsd: number): MineState {
	// Smallest projects first so the gate prompt gets validated cheaply.
	const order: string[] = [...Object.keys(state.exposure)].sort((a, b) => {
		const aT = state.exposure[a]?.prefilteredTurns ?? 0;
		const bT = state.exposure[b]?.prefilteredTurns ?? 0;
		return aT - bT;
	});

	const planned: typeof state.plannedBatches = [];
	let id = 1;
	for (const project of order) {
		const remaining = state.exposure[project]?.prefilteredTurns ?? 0;
		const numBatches = Math.max(1, Math.ceil(remaining / batchSize));
		for (let i = 0; i < numBatches; i++) {
			planned.push({
				id: id++,
				project,
				batchSize,
				maxCostUsd,
				status: "pending",
			});
		}
	}
	state.plannedBatches = planned;
	return state;
}

async function runBatch(state: MineState, args: Args): Promise<void> {
	const project = args.project;
	if (!project) {
		console.error("Error: --project is required when not --dry-run.");
		process.exit(2);
	}

	if (args.resetCheckpoint) {
		console.log(`Resetting checkpoint for ${project}.`);
		resetCheckpoint(state, project);
		saveState(state);
	}

	const tracker = new CostTracker(args.maxCostUsd);
	const sessions = listSessionsForProject(project);
	console.log(
		`[${project}] ${sessions.length} sessions, batch size ${args.batchSize}, cap ${args.maxCostUsd.toFixed(2)} USD`,
	);

	let stoppedReason: "batch-size" | "cost-cap" | "exhausted" = "exhausted";
	const startedAt = new Date();

	outer: for (const filePath of sessions) {
		const messages = parseTranscript(filePath);
		const turns = pairTurns(messages);
		if (turns.length === 0) continue;

		const sessionId = turns[0].sessionId;
		const lastDone = lastTurnFor(state, project, sessionId);

		const candidates = turns.filter((t) => t.turnIndex > lastDone);

		for (const turn of candidates) {
			if (tracker.snapshot().gateCalls >= args.batchSize) {
				stoppedReason = "batch-size";
				break outer;
			}
			if (tracker.overBudget()) {
				stoppedReason = "cost-cap";
				break outer;
			}

			const result = await ingestTurn(turn, {
				sessionId,
				projectName: project.replace(/^-Volumes-stuff-/, ""),
			});

			if (result.outcome === "error") {
				console.error(`  capture failed for ${result.sourceId}: ${result.reason}`);
			}
			if (result.outcome === "captured") tracker.recordCapture();

			setLastTurnFor(state, project, sessionId, turn.turnIndex);

			if (result.gated) {
				tracker.record(result.usage.inputTokens, result.usage.outputTokens);
				const snap = tracker.snapshot();
				if (snap.gateCalls % 10 === 0) {
					console.log(
						`  gated ${snap.gateCalls}/${args.batchSize}, captured ${snap.captures}, $${snap.usd.toFixed(2)}/$${args.maxCostUsd.toFixed(2)}`,
					);
					saveState(state);
				}
			}
		}
	}

	const snap = tracker.snapshot();
	state.cumulativeUsd += snap.usd;
	state.runLog.push({
		id: state.runLog.length + 1,
		date: startedAt.toISOString(),
		project,
		turnsGated: snap.gateCalls,
		turnsCaptured: snap.captures,
		inputTokens: snap.inputTokens,
		outputTokens: snap.outputTokens,
		usd: snap.usd,
		cumulativeUsd: state.cumulativeUsd,
		stoppedReason,
	});

	const pendingForProject = state.plannedBatches.find(
		(b) => b.project === project && b.status === "pending",
	);
	if (pendingForProject) {
		pendingForProject.status = "completed";
		pendingForProject.completedAt = new Date().toISOString();
		pendingForProject.turnsGated = snap.gateCalls;
		pendingForProject.turnsCaptured = snap.captures;
		pendingForProject.usd = snap.usd;
	}

	saveState(state);
	writeProgress(state);

	console.log(
		`\nDone. gated ${snap.gateCalls}, captured ${snap.captures}, spent $${snap.usd.toFixed(2)}, stop reason: ${stoppedReason}`,
	);
	console.log(`Progress: ${progressFilePath()}`);

	await flushBackground();
}

async function runDryRun(args: Args): Promise<void> {
	console.log("Measuring exposure across ingestable projects (no API calls)...\n");
	let state = measureExposure();
	state = planBatches(state, args.batchSize, args.maxCostUsd);
	saveState(state);
	writeProgress(state);

	for (const project of Object.keys(state.exposure)) {
		const exp = state.exposure[project];
		if (!exp) continue;
		console.log(
			`  ${project}: ${exp.files} files, ${exp.turnPairs} turn pairs, ${exp.prefilteredTurns} after pre-filter`,
		);
	}
	const total = Object.values(state.exposure).reduce((s, e) => s + (e?.prefilteredTurns ?? 0), 0);
	const lowUsd = (total * 0.003).toFixed(2);
	const highUsd = (total * 0.005).toFixed(2);
	console.log(`\nTotal pre-filtered: ${total} turns. Projected gate spend: $${lowUsd}–${highUsd}.`);
	console.log(`\nState file:    ${statePath()}`);
	console.log(`Progress file: ${progressFilePath()}`);
	console.log(
		`\nNext: bun run mine --project ${state.plannedBatches[0]?.project ?? "<project>"} --batch-size ${args.batchSize} --max-cost-usd ${args.maxCostUsd}`,
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.dryRun) {
		await runDryRun(args);
		return;
	}

	let state = loadState();
	if (!state) {
		console.log("No state file yet — measuring exposure first.");
		state = measureExposure();
		state = planBatches(state, args.batchSize, args.maxCostUsd);
		saveState(state);
		writeProgress(state);
	}

	await runBatch(state, args);
}

main().catch((err) => {
	console.error(`Mine failed: ${(err as Error).stack ?? (err as Error).message}`);
	process.exit(1);
});

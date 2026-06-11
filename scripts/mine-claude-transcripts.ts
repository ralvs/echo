#!/usr/bin/env bun
/**
 * Mine Claude Code transcripts into Echo thoughts.
 *
 * Cost-safe: scans a hardcoded allowlist of projects, applies a cheap regex
 * pre-filter, runs each surviving turn through a Haiku relevance gate, and
 * POSTs gate-positive captures to /api/thoughts. Stops gracefully when either
 * the per-batch turn cap or USD cap is hit. Resume-safe via a checkpoint file
 * keyed by (project, sessionId, turnIndex).
 *
 * The user runs this command. This script never auto-runs.
 *
 * Examples:
 *   bun run scripts/mine-claude-transcripts.ts --dry-run
 *   bun run scripts/mine-claude-transcripts.ts --project quantic --batch-size 250
 *   bun run scripts/mine-claude-transcripts.ts --project echo --max-cost-usd 3
 *   bun run scripts/mine-claude-transcripts.ts --project worthscene --reset-checkpoint
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CostTracker } from "@/scripts/lib/cost-tracker";
import { ingestTurn } from "@/scripts/lib/ingest";
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
import {
	ALLOWED_PROJECT_DIRS,
	type AllowedProjectDir,
	resolveProjectDir,
} from "@/scripts/mine-claude-transcripts.allowlist";

const PROJECTS_ROOT = `${homedir()}/.claude/projects`;

type Args = {
	dryRun: boolean;
	project?: AllowedProjectDir;
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
					`Error: project "${name}" not in allowlist. Allowed: ${ALLOWED_PROJECT_DIRS.join(", ")}`,
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
  --project <name>         Required when not dry-run. One of: ${Object.keys({
		echo: 1,
		worthscene: 1,
		ora: 1,
		quantic: 1,
	}).join(", ")}
  --batch-size <N>         Cap gate calls per run (default 250).
  --max-cost-usd <N>       Cap USD spend per run (default 1.5).
  --reset-checkpoint       Clear checkpoint for the chosen project before running.
  -h, --help               Show this help.

State files:
  ${statePath()}
  ${progressFilePath()}
`);
}

function listSessionsForProject(project: AllowedProjectDir): string[] {
	const dir = join(PROJECTS_ROOT, project);
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(dir, f));
	} catch (err) {
		console.error(`Project dir missing: ${dir} (${(err as Error).message})`);
		return [];
	}
}

function measureExposure(): MineState {
	const state = loadState() ?? emptyState();
	for (const project of ALLOWED_PROJECT_DIRS) {
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
	const order: AllowedProjectDir[] = [...ALLOWED_PROJECT_DIRS].sort((a, b) => {
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
}

async function runDryRun(args: Args): Promise<void> {
	console.log("Measuring exposure across allowlisted projects (no API calls)...\n");
	let state = measureExposure();
	state = planBatches(state, args.batchSize, args.maxCostUsd);
	saveState(state);
	writeProgress(state);

	for (const project of ALLOWED_PROJECT_DIRS) {
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { AllowedProjectDir } from "@/scripts/mine-claude-transcripts.allowlist";

export type ProjectExposure = {
	files: number;
	userMsgs: number;
	assistantMsgs: number;
	turnPairs: number;
	prefilteredTurns: number;
};

export type PlannedBatch = {
	id: number;
	project: AllowedProjectDir;
	batchSize: number;
	maxCostUsd: number;
	status: "pending" | "completed";
	completedAt?: string;
	turnsGated?: number;
	turnsCaptured?: number;
	usd?: number;
};

export type RunLogEntry = {
	id: number;
	date: string;
	project: AllowedProjectDir;
	turnsGated: number;
	turnsCaptured: number;
	inputTokens: number;
	outputTokens: number;
	usd: number;
	cumulativeUsd: number;
	stoppedReason: "batch-size" | "cost-cap" | "exhausted";
};

export type Checkpoint = {
	[sessionId: string]: { lastTurnIndex: number };
};

export type MineState = {
	createdAt: string;
	lastUpdatedAt: string;
	exposure: Partial<Record<AllowedProjectDir, ProjectExposure>>;
	plannedBatches: PlannedBatch[];
	runLog: RunLogEntry[];
	checkpoint: Record<AllowedProjectDir, Checkpoint>;
	cumulativeUsd: number;
};

const STATE_PATH = `${homedir()}/.echo-mine-state.json`;

export function loadState(): MineState | null {
	if (!existsSync(STATE_PATH)) return null;
	try {
		const raw = readFileSync(STATE_PATH, "utf-8");
		return JSON.parse(raw) as MineState;
	} catch (err) {
		throw new Error(`Failed to read ${STATE_PATH}: ${(err as Error).message}`);
	}
}

export function saveState(state: MineState): void {
	state.lastUpdatedAt = new Date().toISOString();
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function emptyState(): MineState {
	const now = new Date().toISOString();
	return {
		createdAt: now,
		lastUpdatedAt: now,
		exposure: {},
		plannedBatches: [],
		runLog: [],
		checkpoint: {} as Record<AllowedProjectDir, Checkpoint>,
		cumulativeUsd: 0,
	};
}

export function statePath(): string {
	return STATE_PATH;
}

export function lastTurnFor(
	state: MineState,
	project: AllowedProjectDir,
	sessionId: string,
): number {
	return state.checkpoint[project]?.[sessionId]?.lastTurnIndex ?? -1;
}

export function setLastTurnFor(
	state: MineState,
	project: AllowedProjectDir,
	sessionId: string,
	turnIndex: number,
): void {
	if (!state.checkpoint[project]) state.checkpoint[project] = {};
	state.checkpoint[project][sessionId] = { lastTurnIndex: turnIndex };
}

export function resetCheckpoint(state: MineState, project: AllowedProjectDir): void {
	state.checkpoint[project] = {};
}

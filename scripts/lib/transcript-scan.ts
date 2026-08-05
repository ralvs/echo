/**
 * Shared transcript scanning: finds recently-modified Claude Code and Grok
 * CLI sessions, applies the ingest-scope guard (personal projects only —
 * see ./ingest-scope.ts), and yields the turns worth feeding into the
 * capture pipeline.
 *
 * The scope guard runs before any full-content parsing: for Claude
 * transcripts that means reading only the leading `cwd` field of the JSONL
 * file (see readTranscriptCwd), and for Grok sessions it means decoding the
 * session directory name (see grok-transcript.ts's findRecentGrokSessions +
 * ingest-scope.ts's decodeGrokCwd) — never the session content itself.
 *
 * catch-up.ts (Stop-hook adjacent, whole recent window) and nightly.ts (the
 * launchd entry point) both consume scanWindow; the mine CLI (backfill with
 * a cost budget) has its own project-scoped listing but shares the same
 * isIngestable guard and transcript-prefilter primitives.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	findRecentGrokSessions,
	grokCwdDirFromPath,
	isInteractiveGrokSession,
	parseGrokHistory,
} from "./grok-transcript";
import { decodeGrokCwd, isIngestable } from "./ingest-scope";
import { ownerText } from "./owner-message";
import {
	pairTurns,
	parseTranscript,
	passesPrefilter,
	type RawTranscriptMessage,
	type Turn,
} from "./transcript-prefilter";

/**
 * Root of the Claude Code transcript tree. Overridable via
 * ECHO_CLAUDE_PROJECTS_ROOT so tests can point this at a tmp fixture tree
 * instead of the real ~/.claude/projects (mirrors ECHO_LOG_DIR in ingest.ts).
 */
function projectsRoot(): string {
	return process.env.ECHO_CLAUDE_PROJECTS_ROOT || join(homedir(), ".claude", "projects");
}

export type ScannedTurn = Turn & {
	projectName?: string;
	transcriptPath: string;
	source: "claude" | "grok";
};

/**
 * Narrows a turn's user message to the Owner-authored residue before anything
 * downstream sees it. Without this the harness preamble (system reminders, the
 * global CLAUDE.md, MCP/skill listings) dominates the text that gets embedded
 * for grounding and handed to the classifier — kilobytes of machine noise
 * around a sentence of actual signal. passesPrefilter drops what reduces to
 * nothing; this makes sure what survives is only the Owner's words.
 */
function withOwnerMessage(turn: Turn): Turn {
	return { ...turn, userMessage: ownerText(turn.userMessage) };
}

export function findRecentTranscripts(sinceMs: number): string[] {
	const results: string[] = [];
	const root = projectsRoot();
	let projectDirs: string[];
	try {
		projectDirs = readdirSync(root);
	} catch {
		console.error(`[transcript-scan] cannot read ${root}`);
		return [];
	}
	for (const dir of projectDirs) {
		const projectPath = join(root, dir);
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

export function projectNameFromPath(transcriptPath: string): string | undefined {
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

/**
 * The cwd a Claude Code transcript's session ran in, read from the leading
 * `cwd` field on its JSONL lines — without parsing the whole file. This is
 * the pre-content scope check: only a small leading byte window is read, so
 * a large transcript that fails the guard is never fully loaded.
 */
export function readTranscriptCwd(filePath: string, maxBytes = 8192, maxLines = 5): string | null {
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return null;
	}
	try {
		const buf = Buffer.alloc(maxBytes);
		const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
		const text = buf.toString("utf-8", 0, bytesRead);
		const lines = text.split(/\r?\n/).slice(0, maxLines);
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const obj = JSON.parse(trimmed) as { cwd?: string };
				if (typeof obj.cwd === "string" && obj.cwd) return obj.cwd;
			} catch {
				// Likely truncated by the byte cap, or a malformed line — skip it.
			}
		}
	} finally {
		closeSync(fd);
	}
	return null;
}

/**
 * Scans a single Claude Code transcript file, applying the scope guard
 * before parsing content. Shared by scanWindow and catch-up.ts's --file
 * flag, which processes one caller-supplied file outside the time window.
 */
export function scanClaudeFile(filePath: string): ScannedTurn[] {
	const cwd = readTranscriptCwd(filePath);
	if (!isIngestable(cwd)) return [];

	let messages: RawTranscriptMessage[];
	try {
		messages = parseTranscript(filePath);
	} catch (err) {
		console.error(`[transcript-scan] failed to parse ${filePath}: ${(err as Error).message}`);
		return [];
	}

	const projectName = projectNameFromPath(filePath);
	const out: ScannedTurn[] = [];
	for (const raw of pairTurns(messages)) {
		const turn = withOwnerMessage(raw);
		if (!passesPrefilter(turn)) continue;
		out.push({ ...turn, projectName, transcriptPath: filePath, source: "claude" });
	}
	return out;
}

/**
 * Scans a single Grok CLI session's chat_history.jsonl, applying the scope
 * guard against the session directory name before parsing content.
 */
export function scanGrokFile(filePath: string): ScannedTurn[] {
	const dirName = grokCwdDirFromPath(filePath);
	const cwd = dirName ? decodeGrokCwd(dirName) : null;
	if (!isIngestable(cwd)) return [];

	// Subagent sessions are agent-to-agent traffic: the "user" role carries a
	// delegation prompt, not the Owner. See isInteractiveGrokSession.
	if (!isInteractiveGrokSession(filePath)) return [];

	let turns: Turn[];
	try {
		turns = parseGrokHistory(filePath);
	} catch (err) {
		console.error(`[transcript-scan] failed to parse ${filePath}: ${(err as Error).message}`);
		return [];
	}

	const out: ScannedTurn[] = [];
	for (const raw of turns) {
		const turn = withOwnerMessage(raw);
		if (!passesPrefilter(turn)) continue;
		out.push({ ...turn, transcriptPath: filePath, source: "grok" });
	}
	return out;
}

/**
 * Finds turns from both Claude Code and Grok CLI sessions modified within
 * the last `hours`, restricted to ingestable (personal-project) cwds, and
 * returns them sorted most-recent-first.
 *
 * `opts.only` narrows to transcript paths containing any of the given
 * substrings (e.g. a project directory name) — mirrors the mine CLI's
 * project narrowing for callers that want a scoped scan.
 */
export function scanWindow(hours: number, opts?: { only?: string[] }): ScannedTurn[] {
	const sinceMs = Date.now() - hours * 60 * 60 * 1000;
	const only = opts?.only;
	const matchesOnly = (path: string) => !only?.length || only.some((o) => path.includes(o));

	const turns: ScannedTurn[] = [];

	for (const filePath of findRecentTranscripts(sinceMs).filter(matchesOnly)) {
		turns.push(...scanClaudeFile(filePath));
	}

	for (const filePath of findRecentGrokSessions(sinceMs).filter(matchesOnly)) {
		turns.push(...scanGrokFile(filePath));
	}

	turns.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
	return turns;
}

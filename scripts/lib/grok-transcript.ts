/**
 * Grok CLI session parsing — mirrors transcript-prefilter.ts's Claude Code
 * path so both sources feed the same Turn shape into passesPrefilter and
 * ingestTurn.
 *
 * Sessions live at ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/chat_history.jsonl,
 * a flat JSONL file with a `type` discriminator per entry. Only user/assistant
 * text is kept: tool_result, reasoning (chain-of-thought), and system entries
 * are noise for capture purposes and are skipped.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Turn } from "./transcript-prefilter";

const HISTORY_FILENAME = "chat_history.jsonl";

/**
 * Root of the Grok CLI session tree. Overridable via ECHO_GROK_SESSIONS_ROOT
 * so tests can point this at a tmp fixture tree instead of the real
 * ~/.grok/sessions (mirrors ECHO_LOG_DIR in ingest.ts).
 */
function grokSessionsRoot(): string {
	return process.env.ECHO_GROK_SESSIONS_ROOT || join(homedir(), ".grok", "sessions");
}

type GrokContentPart = { type?: string; text?: string };

type GrokEntry = {
	type?: "user" | "assistant" | "tool_result" | "reasoning" | "system";
	content?: string | GrokContentPart[];
	prompt_index?: number;
	timestamp?: string;
};

function extractGrokText(content: GrokEntry["content"]): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p) => typeof p?.text === "string")
			.map((p) => p.text as string)
			.join("\n")
			.trim();
	}
	return "";
}

/** The session uuid is the parent directory of chat_history.jsonl. */
export function sessionUuidFromPath(historyPath: string): string {
	const parts = historyPath.split("/");
	const idx = parts.lastIndexOf(HISTORY_FILENAME);
	return idx > 0 ? parts[idx - 1] : "";
}

/**
 * The URL-encoded cwd directory name a session's chat_history.jsonl sits
 * under, i.e. the first path segment below the sessions root. Computed
 * relative to grokSessionsRoot() (not by searching for a literal "sessions"
 * path component) so it works whether that root is the real ~/.grok/sessions
 * or a test's ECHO_GROK_SESSIONS_ROOT override.
 */
export function grokCwdDirFromPath(historyPath: string): string | undefined {
	const rel = relative(grokSessionsRoot(), historyPath);
	if (rel.startsWith("..")) return undefined;
	const [first] = rel.split(sep);
	return first || undefined;
}

/**
 * Finds Grok chat_history.jsonl files modified within the window, across
 * all session directories regardless of cwd — the scope guard is applied
 * by the caller (see transcript-scan.ts's scanGrokFile), which decodes the
 * cwd from the directory name before any of these files are read.
 */
export function findRecentGrokSessions(sinceMs: number): string[] {
	const root = grokSessionsRoot();
	const results: string[] = [];
	let cwdDirs: string[];
	try {
		cwdDirs = readdirSync(root);
	} catch {
		return [];
	}
	for (const cwdDir of cwdDirs) {
		const cwdPath = join(root, cwdDir);
		let sessionDirs: string[];
		try {
			sessionDirs = readdirSync(cwdPath);
		} catch {
			continue;
		}
		for (const sessionDir of sessionDirs) {
			const historyPath = join(cwdPath, sessionDir, HISTORY_FILENAME);
			try {
				const stat = statSync(historyPath);
				if (stat.mtimeMs >= sinceMs) results.push(historyPath);
			} catch {
				// no chat_history.jsonl in this session dir, or unreadable
			}
		}
	}
	return results;
}

/**
 * Parses one Grok chat_history.jsonl into user→assistant Turn pairs,
 * skipping tool_result/reasoning/system entries. Mirrors pairTurns in
 * transcript-prefilter.ts: a turn is one user message followed by the next
 * assistant message(s), joined by newlines if there are several before the
 * next user message.
 */
export function parseGrokHistory(filePath: string): Turn[] {
	const sessionId = sessionUuidFromPath(filePath);

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}
	const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

	const turns: Turn[] = [];
	let pendingUser: { text: string; ts: string } | null = null;
	let assistantBuffer: string[] = [];
	let lastTs = "";

	const flush = () => {
		if (pendingUser && assistantBuffer.length > 0) {
			const assistantText = assistantBuffer.join("\n").trim();
			if (assistantText) {
				turns.push({
					sessionId,
					turnIndex: turns.length,
					userMessage: pendingUser.text,
					assistantMessage: assistantText,
					timestamp: pendingUser.ts,
				});
			}
		}
		pendingUser = null;
		assistantBuffer = [];
	};

	for (const line of lines) {
		let entry: GrokEntry;
		try {
			entry = JSON.parse(line) as GrokEntry;
		} catch {
			continue;
		}

		if (entry.type === "tool_result" || entry.type === "reasoning" || entry.type === "system") {
			continue;
		}

		if (entry.type === "user") {
			flush();
			const text = extractGrokText(entry.content);
			if (text) {
				pendingUser = { text, ts: entry.timestamp ?? lastTs };
			}
		} else if (entry.type === "assistant" && pendingUser) {
			const text = extractGrokText(entry.content);
			if (text) assistantBuffer.push(text);
		}

		if (entry.timestamp) lastTs = entry.timestamp;
	}
	flush();
	return turns;
}

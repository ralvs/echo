import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanWindow } from "./transcript-scan.ts";

/**
 * The security-critical test for the whole feature: given a tmp tree with
 * personal-project sessions (cwd under /Volumes/stuff/renan/) and
 * employer-project sessions (cwd under /Volumes/stuff/lss, a sibling — see
 * ingest-scope.ts), scanWindow must return turns from the former and
 * nothing at all from the latter.
 *
 * The cwd values below don't need to exist on disk — isIngestable falls
 * back to a lexical resolve() when realpath fails, which is still a safe
 * prefix comparison (see ingest-scope.test.ts).
 */

const NOW = Date.now();

const LONG_USER_MSG =
	"Here is a fairly long user question about how the caching layer should invalidate entries " +
	"when the underlying source data changes, since we saw stale reads in production yesterday " +
	"and it caused a confusing on-call page that took an hour to root-cause properly.";
const ASSISTANT_MSG =
	"You should invalidate on write and add a short TTL as a backstop for any missed invalidations.";

function writeClaudeTranscript(
	root: string,
	projectDir: string,
	fileName: string,
	cwd: string | undefined,
) {
	const dir = join(root, projectDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, fileName);
	const lines: Array<Record<string, unknown>> = [];
	if (cwd !== undefined) {
		lines.push({
			type: "user",
			uuid: "u1",
			timestamp: new Date(NOW).toISOString(),
			sessionId: "session-1",
			cwd,
			message: { role: "user", content: LONG_USER_MSG },
		});
	} else {
		// No cwd field at all — undeterminable.
		lines.push({
			type: "user",
			uuid: "u1",
			timestamp: new Date(NOW).toISOString(),
			sessionId: "session-1",
			message: { role: "user", content: LONG_USER_MSG },
		});
	}
	lines.push({
		type: "assistant",
		uuid: "a1",
		timestamp: new Date(NOW).toISOString(),
		sessionId: "session-1",
		...(cwd !== undefined ? { cwd } : {}),
		message: { role: "assistant", content: ASSISTANT_MSG },
	});
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");
	return path;
}

function writeGrokSession(root: string, encodedCwd: string, uuid: string) {
	const dir = join(root, encodedCwd, uuid);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "chat_history.jsonl");
	const lines = [
		{
			type: "user",
			content: LONG_USER_MSG,
			prompt_index: 0,
			timestamp: new Date(NOW).toISOString(),
		},
		{ type: "assistant", content: ASSISTANT_MSG, model_id: "grok-4" },
	];
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");
	return path;
}

describe("scanWindow", () => {
	let claudeRoot: string;
	let grokRoot: string;
	let prevClaudeRoot: string | undefined;
	let prevGrokRoot: string | undefined;

	beforeEach(() => {
		claudeRoot = mkdtempSync(join(tmpdir(), "transcript-scan-claude-"));
		grokRoot = mkdtempSync(join(tmpdir(), "transcript-scan-grok-"));
		prevClaudeRoot = process.env.ECHO_CLAUDE_PROJECTS_ROOT;
		prevGrokRoot = process.env.ECHO_GROK_SESSIONS_ROOT;
		process.env.ECHO_CLAUDE_PROJECTS_ROOT = claudeRoot;
		process.env.ECHO_GROK_SESSIONS_ROOT = grokRoot;
	});

	afterEach(() => {
		rmSync(claudeRoot, { recursive: true, force: true });
		rmSync(grokRoot, { recursive: true, force: true });
		if (prevClaudeRoot === undefined) delete process.env.ECHO_CLAUDE_PROJECTS_ROOT;
		else process.env.ECHO_CLAUDE_PROJECTS_ROOT = prevClaudeRoot;
		if (prevGrokRoot === undefined) delete process.env.ECHO_GROK_SESSIONS_ROOT;
		else process.env.ECHO_GROK_SESSIONS_ROOT = prevGrokRoot;
	});

	it("returns turns from personal-project Claude transcripts and none from employer ones", () => {
		writeClaudeTranscript(
			claudeRoot,
			"-Volumes-stuff-renan-x",
			"personal.jsonl",
			"/Volumes/stuff/renan/x",
		);
		writeClaudeTranscript(claudeRoot, "-Volumes-stuff-lss", "employer.jsonl", "/Volumes/stuff/lss");

		const turns = scanWindow(48);

		expect(turns.length).toBeGreaterThan(0);
		expect(turns.every((t) => t.source === "claude")).toBe(true);
		expect(turns.some((t) => t.userMessage === LONG_USER_MSG)).toBe(true);
		// No turn should have come from the employer transcript.
		expect(turns.every((t) => !t.transcriptPath.includes("employer.jsonl"))).toBe(true);
	});

	it("skips a Claude transcript whose cwd cannot be determined", () => {
		writeClaudeTranscript(claudeRoot, "-Volumes-stuff-unknown", "no-cwd.jsonl", undefined);

		const turns = scanWindow(48);

		expect(turns).toHaveLength(0);
	});

	it("returns turns from personal-project Grok sessions and none from employer ones", () => {
		writeGrokSession(
			grokRoot,
			encodeURIComponent("/Volumes/stuff/renan/dispatch"),
			"grok-uuid-personal",
		);
		writeGrokSession(grokRoot, encodeURIComponent("/Volumes/stuff/members"), "grok-uuid-employer");

		const turns = scanWindow(48);

		expect(turns.length).toBeGreaterThan(0);
		expect(turns.every((t) => t.source === "grok")).toBe(true);
		expect(turns.every((t) => !t.transcriptPath.includes("grok-uuid-employer"))).toBe(true);
		expect(turns.some((t) => t.sessionId === "grok-uuid-personal")).toBe(true);
	});

	it("combines both sources, all scoped to personal projects", () => {
		writeClaudeTranscript(
			claudeRoot,
			"-Volumes-stuff-renan-x",
			"personal.jsonl",
			"/Volumes/stuff/renan/x",
		);
		writeClaudeTranscript(claudeRoot, "-Volumes-stuff-lss", "employer.jsonl", "/Volumes/stuff/lss");
		writeGrokSession(
			grokRoot,
			encodeURIComponent("/Volumes/stuff/renan/dispatch"),
			"grok-uuid-personal",
		);
		writeGrokSession(
			grokRoot,
			encodeURIComponent("/Volumes/stuff/engines.code-workspace"),
			"grok-uuid-employer",
		);

		const turns = scanWindow(48);

		expect(turns.some((t) => t.source === "claude")).toBe(true);
		expect(turns.some((t) => t.source === "grok")).toBe(true);
		expect(turns.every((t) => !t.transcriptPath.includes("employer"))).toBe(true);
	});

	it("respects the hours window", () => {
		const filePath = writeClaudeTranscript(
			claudeRoot,
			"-Volumes-stuff-renan-x",
			"personal.jsonl",
			"/Volumes/stuff/renan/x",
		);
		// Backdate the file's mtime well outside the window.
		const old = new Date(NOW - 1000 * 60 * 60 * 24 * 30);
		utimesSync(filePath, old, old);

		const turns = scanWindow(1);

		expect(turns).toHaveLength(0);
	});
});

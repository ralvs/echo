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
/** The header the Grok CLI injects to open an Owner-driven session. */
const GROK_HEADER =
	"<user_info>\nOS Version: macos\nShell: /bin/zsh\nWorkspace Path: /Volumes/stuff/renan/dispatch\n</user_info>";

function writeClaudeTranscript(
	root: string,
	projectDir: string,
	fileName: string,
	cwd: string | undefined,
	userMessage: string = LONG_USER_MSG,
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
			message: { role: "user", content: userMessage },
		});
	} else {
		// No cwd field at all — undeterminable.
		lines.push({
			type: "user",
			uuid: "u1",
			timestamp: new Date(NOW).toISOString(),
			sessionId: "session-1",
			message: { role: "user", content: userMessage },
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

/**
 * `interactive: false` writes a subagent session — one that opens straight
 * into inherited context with no <user_info> header, the way the Grok CLI
 * records an agent it spawned rather than a session the Owner drove.
 */
function writeGrokSession(
	root: string,
	encodedCwd: string,
	uuid: string,
	opts: { interactive?: boolean } = {},
) {
	const dir = join(root, encodedCwd, uuid);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "chat_history.jsonl");
	const opener =
		opts.interactive === false ? "<system-reminder>context</system-reminder>" : GROK_HEADER;
	const lines = [
		{
			type: "user",
			content: `${opener}\n<user_query>${LONG_USER_MSG}</user_query>`,
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

	/**
	 * Regression: the 2026-08-04 dream run mined 7 of 12 proposals from turns
	 * whose "user message" was nothing but harness preamble — system reminders
	 * and the global CLAUDE.md echoed back under the user role. Those turns
	 * passed the old filter precisely because they were long.
	 */
	it("drops a turn whose user message is only harness preamble", () => {
		writeClaudeTranscript(
			claudeRoot,
			"-Volumes-stuff-renan-x",
			"preamble.jsonl",
			"/Volumes/stuff/renan/x",
			`<system-reminder>${LONG_USER_MSG}\n${LONG_USER_MSG}</system-reminder>`,
		);

		expect(scanWindow(1)).toHaveLength(0);
	});

	it("keeps only the Owner's residue when a preamble wraps real text", () => {
		writeClaudeTranscript(
			claudeRoot,
			"-Volumes-stuff-renan-x",
			"residue.jsonl",
			"/Volumes/stuff/renan/x",
			`<system-reminder>${LONG_USER_MSG}</system-reminder>\nkeep finished tasks on the Today page`,
		);

		const turns = scanWindow(1);

		expect(turns).toHaveLength(1);
		expect(turns[0].userMessage).toBe("keep finished tasks on the Today page");
	});

	it("drops Grok subagent sessions while keeping the Owner's own", () => {
		writeGrokSession(grokRoot, encodeURIComponent("/Volumes/stuff/renan/dispatch"), "grok-owner");
		writeGrokSession(
			grokRoot,
			encodeURIComponent("/Volumes/stuff/renan/dispatch"),
			"grok-subagent",
			{
				interactive: false,
			},
		);

		const turns = scanWindow(48);

		expect(turns).toHaveLength(1);
		expect(turns[0].sessionId).toBe("grok-owner");
	});

	it("unwraps the Grok <user_query> tag rather than discarding its contents", () => {
		writeGrokSession(grokRoot, encodeURIComponent("/Volumes/stuff/renan/dispatch"), "grok-owner");

		const turns = scanWindow(48);

		expect(turns[0].userMessage).toBe(LONG_USER_MSG);
	});

	it("keeps a short correction the old length floor would have discarded", () => {
		writeClaudeTranscript(
			claudeRoot,
			"-Volumes-stuff-renan-x",
			"short.jsonl",
			"/Volumes/stuff/renan/x",
			"no, use Luxon for dates instead of date-fns",
		);

		const turns = scanWindow(1);

		expect(turns).toHaveLength(1);
		expect(turns[0].userMessage).toBe("no, use Luxon for dates instead of date-fns");
	});
});

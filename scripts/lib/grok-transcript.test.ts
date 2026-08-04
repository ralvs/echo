import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGrokHistory, sessionUuidFromPath } from "./grok-transcript.ts";

function writeHistory(dir: string, uuid: string, lines: unknown[]): string {
	const sessionDir = join(dir, uuid);
	const path = join(sessionDir, "chat_history.jsonl");
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");
	return path;
}

describe("sessionUuidFromPath", () => {
	it("extracts the uuid segment above chat_history.jsonl", () => {
		expect(
			sessionUuidFromPath(
				"/Users/renan/.grok/sessions/%2FVolumes%2Fstuff%2Frenan%2Fecho/abc-123/chat_history.jsonl",
			),
		).toBe("abc-123");
	});

	it("returns empty string when the path doesn't match the expected shape", () => {
		expect(sessionUuidFromPath("/some/other/path.jsonl")).toBe("");
	});
});

describe("parseGrokHistory", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "grok-transcript-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("pairs a user turn with a following string-content assistant reply", () => {
		const path = writeHistory(dir, "uuid-1", [
			{
				type: "user",
				content: "Can you help me refactor this module to be cleaner and more testable please",
				prompt_index: 0,
				timestamp: "2026-01-01T00:00:00Z",
			},
			{
				type: "assistant",
				content: "Sure — here's a plan: split the parser from the formatter, then add tests.",
				model_id: "grok-4",
			},
		]);

		const turns = parseGrokHistory(path);
		expect(turns).toHaveLength(1);
		expect(turns[0].sessionId).toBe("uuid-1");
		expect(turns[0].turnIndex).toBe(0);
		expect(turns[0].userMessage).toContain("refactor this module");
		expect(turns[0].assistantMessage).toContain("split the parser");
		expect(turns[0].timestamp).toBe("2026-01-01T00:00:00Z");
	});

	it("handles array-of-parts content on both user and assistant entries", () => {
		const path = writeHistory(dir, "uuid-2", [
			{
				type: "user",
				content: [
					{ type: "text", text: "Here is the first part of my question about the API design " },
					{ type: "text", text: "and here is the second part with more detail." },
				],
			},
			{
				type: "assistant",
				content: [{ type: "text", text: "The API design should separate reads from writes." }],
			},
		]);

		const turns = parseGrokHistory(path);
		expect(turns).toHaveLength(1);
		expect(turns[0].userMessage).toBe(
			"Here is the first part of my question about the API design \nand here is the second part with more detail.",
		);
		expect(turns[0].assistantMessage).toBe("The API design should separate reads from writes.");
	});

	it("skips tool_result, reasoning, and system entries", () => {
		const path = writeHistory(dir, "uuid-3", [
			{ type: "system", content: "You are a helpful coding assistant." },
			{
				type: "user",
				content: "What is the best way to structure this large feature across multiple files",
			},
			{ type: "reasoning", encrypted_content: "opaque", id: "r1", status: "done", summary: "..." },
			{ type: "tool_call_placeholder" },
			{
				type: "tool_result",
				content: "file contents here that should never leak into a captured turn",
				tool_call_id: "call-1",
			},
			{
				type: "assistant",
				content: "Split it into a scanner, a parser, and a formatter module.",
				tool_calls: [{ id: "call-1" }],
			},
		]);

		const turns = parseGrokHistory(path);
		expect(turns).toHaveLength(1);
		expect(turns[0].userMessage).not.toContain("You are a helpful");
		expect(turns[0].assistantMessage).not.toContain("file contents here");
		expect(turns[0].assistantMessage).toBe(
			"Split it into a scanner, a parser, and a formatter module.",
		);
	});

	it("joins multiple assistant messages before the next user message into one turn", () => {
		const path = writeHistory(dir, "uuid-4", [
			{ type: "user", content: "Walk me through the deployment steps for this service in detail" },
			{ type: "assistant", content: "Step 1: build the image." },
			{ type: "assistant", content: "Step 2: push it to the registry." },
		]);

		const turns = parseGrokHistory(path);
		expect(turns).toHaveLength(1);
		expect(turns[0].assistantMessage).toBe(
			"Step 1: build the image.\nStep 2: push it to the registry.",
		);
	});

	it("assigns sequential turnIndex across multiple user/assistant pairs", () => {
		const path = writeHistory(dir, "uuid-5", [
			{ type: "user", content: "First question about the overall system architecture here" },
			{ type: "assistant", content: "First answer about the architecture." },
			{ type: "user", content: "Second question following up on the previous architecture answer" },
			{ type: "assistant", content: "Second answer with more detail." },
		]);

		const turns = parseGrokHistory(path);
		expect(turns).toHaveLength(2);
		expect(turns[0].turnIndex).toBe(0);
		expect(turns[1].turnIndex).toBe(1);
	});

	it("returns an empty array for a missing file", () => {
		expect(parseGrokHistory(join(dir, "does-not-exist", "chat_history.jsonl"))).toEqual([]);
	});
});

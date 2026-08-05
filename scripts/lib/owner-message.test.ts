import { describe, expect, it } from "vitest";
import { isOwnerAuthored, ownerText, stripMachineBlocks } from "./owner-message.ts";

describe("stripMachineBlocks", () => {
	it("removes a paired harness block and keeps the Owner's text", () => {
		const raw = "<system-reminder>lots of context</system-reminder>\n\nfix the login redirect";
		expect(stripMachineBlocks(raw)).toBe("fix the login redirect");
	});

	it("removes an unterminated block through to the end of the message", () => {
		// A transcript truncated mid-block must not leak its tail as residue.
		const raw = "do the thing\n<system-reminder>context that never closes";
		expect(stripMachineBlocks(raw)).toBe("do the thing");
	});

	it("removes every occurrence, not just the first", () => {
		const raw = "<user_info>a</user_info> keep me <system-reminder>b</system-reminder> and me";
		const out = stripMachineBlocks(raw);
		expect(out).toContain("keep me");
		expect(out).toContain("and me");
		expect(out).not.toContain("user_info");
		expect(out).not.toContain("system-reminder");
	});

	it("leaves Owner text that merely quotes markup alone", () => {
		const raw = "why does <div> render before <span> here?";
		expect(stripMachineBlocks(raw)).toBe("why does <div> render before <span> here?");
	});
});

describe("ownerText", () => {
	it("returns empty for a message that is entirely harness preamble", () => {
		// The real shape behind the 2026-08-04 false positives: a 16KB Grok
		// "user" message with no Owner residue whatsoever.
		const raw = `  <system-reminder>
As you answer the user's questions, you can use the following context:
## From: /Users/renan.alves/.claude/Claude.md
# Global CLAUDE.md
Personal preferences applied to all projects.
</system-reminder>`;
		expect(ownerText(raw)).toBe("");
	});

	it("returns empty for a slash-command skill body", () => {
		const raw =
			"Base directory for this skill: /Users/renan.alves/.claude/skills/dream\n\n# Dream\n\nReview and act on proposals.";
		expect(ownerText(raw)).toBe("");
	});

	it("returns empty for a slash-command invocation", () => {
		const raw =
			"<command-message>dream</command-message>\n<command-name>/dream</command-name>\n<command-args>review</command-args>";
		expect(ownerText(raw)).toBe("");
	});

	it("returns empty for replayed tool output", () => {
		expect(ownerText("tool_use_id: toolu_01ABC\nresult: ok")).toBe("");
		expect(ownerText("PostToolUse:Write hook additional context: none")).toBe("");
	});

	it("returns empty for a skills or deferred-tools listing", () => {
		const raw = "The following skills are available for use with the Skill tool:\n- dream: ...";
		expect(ownerText(raw)).toBe("");
	});

	it("keeps the Owner's words when they follow a preamble", () => {
		const raw = `<system-reminder>project context here</system-reminder>
I want completed tasks to stay visible on the Today page for the rest of the day.`;
		expect(ownerText(raw)).toBe(
			"I want completed tasks to stay visible on the Today page for the rest of the day.",
		);
	});

	it("keeps a short correction that a length floor would have discarded", () => {
		expect(ownerText("no, use Luxon not date-fns")).toBe("no, use Luxon not date-fns");
	});

	it("treats null-ish input as machine-authored rather than throwing", () => {
		expect(ownerText("")).toBe("");
		expect(ownerText(undefined as unknown as string)).toBe("");
	});
});

describe("isOwnerAuthored", () => {
	it("separates Owner turns from harness turns", () => {
		expect(isOwnerAuthored("<system-reminder>x</system-reminder>")).toBe(false);
		expect(isOwnerAuthored("ship it to production tonight")).toBe(true);
	});
});

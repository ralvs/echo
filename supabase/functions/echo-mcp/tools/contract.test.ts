import { describe, expect, it } from "vitest";
import { preview, ToolError } from "./contract.ts";

describe("preview", () => {
	it("returns short text unchanged", () => {
		expect(preview("hello", 120)).toBe("hello");
	});

	it("truncates with a single-character ellipsis at the boundary", () => {
		expect(preview("abcdef", 3)).toBe("abc…");
	});

	it("keeps text exactly at the limit untruncated", () => {
		expect(preview("abc", 3)).toBe("abc");
	});

	it("defaults to a 120-character limit", () => {
		const long = "x".repeat(200);
		expect(preview(long)).toBe(`${"x".repeat(120)}…`);
	});
});

describe("ToolError", () => {
	it("is an Error carrying its message verbatim", () => {
		const err = new ToolError("Thought not found: abc");
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("Thought not found: abc");
	});
});

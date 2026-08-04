import { describe, expect, it } from "vitest";
import { decodeGrokCwd, INGEST_ROOTS, isIngestable } from "./ingest-scope.ts";

describe("isIngestable", () => {
	it("admits personal project roots", () => {
		expect(isIngestable("/Volumes/stuff/renan/echo")).toBe(true);
		expect(isIngestable("/Volumes/stuff/renan/dispatch")).toBe(true);
		expect(isIngestable("/Volumes/stuff/renan/worthscene")).toBe(true);
	});

	it("admits nested paths such as worktrees", () => {
		expect(isIngestable("/Volumes/stuff/renan/dispatch/.claude/worktrees/feat-x")).toBe(true);
	});

	it("admits a personal project that does not exist on disk", () => {
		// realpath fails here; the lexical fallback must still admit it.
		expect(isIngestable("/Volumes/stuff/renan/not-created-yet")).toBe(true);
	});

	// The security-critical cases: employer repositories are siblings of renan/.
	it("rejects employer repositories", () => {
		expect(isIngestable("/Volumes/stuff/lss")).toBe(false);
		expect(isIngestable("/Volumes/stuff/members")).toBe(false);
		expect(isIngestable("/Volumes/stuff/engines.code-workspace")).toBe(false);
		expect(isIngestable("/Volumes/stuff/lss/packages/api")).toBe(false);
	});

	it("rejects the shared parent of personal and employer work", () => {
		expect(isIngestable("/Volumes/stuff")).toBe(false);
	});

	it("rejects a sibling whose name merely starts with the root name", () => {
		// Guards against a missing trailing slash in the prefix comparison.
		expect(isIngestable("/Volumes/stuff/renan-employer")).toBe(false);
		expect(isIngestable("/Volumes/stuff/renanoid/project")).toBe(false);
	});

	it("rejects the home directory", () => {
		expect(isIngestable("/Users/renan.alves")).toBe(false);
		expect(isIngestable("/Users/renan.alves/Documents")).toBe(false);
	});

	it("fails closed on an undeterminable cwd", () => {
		expect(isIngestable(undefined)).toBe(false);
		expect(isIngestable(null)).toBe(false);
		expect(isIngestable("")).toBe(false);
		expect(isIngestable("   ")).toBe(false);
	});

	it("fails closed on relative paths", () => {
		expect(isIngestable("renan/echo")).toBe(false);
		expect(isIngestable("../../Volumes/stuff/renan/echo")).toBe(false);
		expect(isIngestable("./echo")).toBe(false);
	});

	it("rejects traversal that escapes the root", () => {
		expect(isIngestable("/Volumes/stuff/renan/../lss")).toBe(false);
		expect(isIngestable("/Volumes/stuff/renan/echo/../../members")).toBe(false);
	});

	it("keeps the allow-root list explicit", () => {
		// A second root is a deliberate decision, not an accident. If this fails,
		// confirm the new root cannot contain employer work before updating it.
		expect(INGEST_ROOTS).toEqual(["/Volumes/stuff/renan/"]);
	});
});

describe("decodeGrokCwd", () => {
	it("decodes a url-encoded session directory name", () => {
		expect(decodeGrokCwd("%2FVolumes%2Fstuff%2Frenan%2Fdispatch")).toBe(
			"/Volumes/stuff/renan/dispatch",
		);
	});

	it("composes with isIngestable to exclude employer sessions", () => {
		const employer = decodeGrokCwd("%2FVolumes%2Fstuff%2Flss");
		expect(employer).toBe("/Volumes/stuff/lss");
		expect(isIngestable(employer)).toBe(false);

		const personal = decodeGrokCwd("%2FVolumes%2Fstuff%2Frenan%2Fdispatch");
		expect(isIngestable(personal)).toBe(true);
	});

	it("fails closed on a malformed or relative segment", () => {
		expect(decodeGrokCwd("%E0%A4%A")).toBeNull();
		expect(decodeGrokCwd("not-a-path")).toBeNull();
		expect(decodeGrokCwd("")).toBeNull();
	});
});

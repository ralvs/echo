import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CaptureInput, CaptureResult } from "@/lib/capture";
import type { CaptureWriter } from "./ingest";

const captureThoughtMock =
	vi.fn<
		(input: CaptureInput, background?: (work: Promise<unknown>) => void) => Promise<CaptureResult>
	>();

vi.mock("@/lib/capture", () => ({
	captureThought: (input: CaptureInput, background?: (work: Promise<unknown>) => void) =>
		captureThoughtMock(input, background),
}));

// Point the module's error logging at a scratch dir for the whole suite so
// tests never touch the real ~/Library/Logs/echo/ingest.err.log.
const testLogDir = mkdtempSync(join(tmpdir(), "echo-ingest-test-"));
process.env.ECHO_LOG_DIR = testLogDir;

const { directWriter, flushBackground, ingestRaw } = await import("./ingest");

beforeAll(() => {
	process.env.ECHO_LOG_DIR = testLogDir;
});

afterAll(() => {
	delete process.env.ECHO_LOG_DIR;
	rmSync(testLogDir, { recursive: true, force: true });
});

afterEach(() => {
	captureThoughtMock.mockReset();
});

type WriterResult = { duplicate: boolean } | Error;

function fakeWriter(result: WriterResult) {
	const calls: CaptureInput[] = [];
	const writer: CaptureWriter = async (input) => {
		calls.push(input);
		if (result instanceof Error) throw result;
		return result;
	};
	return { writer, calls };
}

describe("ingestRaw", () => {
	it("maps a fresh capture to the 'captured' outcome, ungated", async () => {
		const { writer, calls } = fakeWriter({ duplicate: false });

		const result = await ingestRaw(
			{
				content: "bookmark body",
				sourceId: "sess:precompact:4",
				sourceKind: "claude-precompact",
				expiresAt: "2026-07-01T00:00:00Z",
				type: "log",
				topics: ["compaction-bookmark", "echo"],
				memoryType: "episodic",
			},
			{ writer },
		);

		expect(result.outcome).toBe("captured");
		expect(result.gated).toBe(false);
		expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

		// Input shape owned by the seam, not the caller.
		expect(calls[0]).toMatchObject({
			content: "bookmark body",
			source_id: "sess:precompact:4",
			source_kind: "claude-precompact",
			expires_at: "2026-07-01T00:00:00Z",
			type: "log",
			topics: ["compaction-bookmark", "echo"],
			memory_type: "episodic",
		});
	});

	it("omits expires_at when not provided", async () => {
		const { writer, calls } = fakeWriter({ duplicate: false });

		await ingestRaw({ content: "x", sourceId: "s:1", sourceKind: "k" }, { writer });

		expect(calls[0]).not.toHaveProperty("expires_at");
	});

	it("maps server-side dedup to the 'duplicate' outcome", async () => {
		const { writer } = fakeWriter({ duplicate: true });

		const result = await ingestRaw({ content: "x", sourceId: "s:1", sourceKind: "k" }, { writer });

		expect(result.outcome).toBe("duplicate");
	});

	it("never throws — a writer failure becomes the 'error' outcome", async () => {
		const { writer } = fakeWriter(new Error("boom"));

		const result = await ingestRaw({ content: "x", sourceId: "s:1", sourceKind: "k" }, { writer });

		expect(result.outcome).toBe("error");
		expect(result.reason).toContain("boom");
	});

	it("never throws even when error logging itself fails, and preserves the original reason", async () => {
		const { writer } = fakeWriter(new Error("boom"));

		// Point ECHO_LOG_DIR at a path that can't be created as a directory
		// (a plain file sits where the directory would go), so mkdirSync
		// inside logIngestError throws. The logging failure must not leak.
		const blockingFile = join(testLogDir, "not-a-directory");
		writeFileSync(blockingFile, "");
		const badLogDir = join(blockingFile, "nested");
		const previous = process.env.ECHO_LOG_DIR;
		process.env.ECHO_LOG_DIR = badLogDir;

		try {
			const result = await ingestRaw(
				{ content: "x", sourceId: "s:1", sourceKind: "k" },
				{ writer },
			);

			expect(result.outcome).toBe("error");
			expect(result.reason).toContain("boom");
		} finally {
			process.env.ECHO_LOG_DIR = previous;
			rmSync(blockingFile, { force: true });
		}
	});
});

describe("directWriter + flushBackground", () => {
	it("flushBackground awaits background work queued through captureThought", async () => {
		let settled = false;

		captureThoughtMock.mockImplementation(async (_input, background) => {
			const work = new Promise<void>((resolve) =>
				setTimeout(() => {
					settled = true;
					resolve();
				}, 10),
			);
			background?.(work);
			return { kind: "captured", thought: {}, relations: [] } as unknown as CaptureResult;
		});

		const resultPromise = directWriter({ content: "x", source_id: "s:1", source_kind: "k" });

		// The background work hasn't been awaited by directWriter itself.
		await resultPromise;
		expect(settled).toBe(false);

		await flushBackground();

		expect(settled).toBe(true);
	});
});

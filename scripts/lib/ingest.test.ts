import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestRaw } from "./ingest";

type FetchResult = { ok: boolean; status?: number; json?: unknown; text?: string };

function mockFetch(result: FetchResult) {
	const calls: { url: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
		calls.push({ url, body: JSON.parse(init.body) });
		return {
			ok: result.ok,
			status: result.status ?? 200,
			json: async () => result.json ?? {},
			text: async () => result.text ?? "",
		};
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("ingestRaw", () => {
	it("maps a fresh capture to the 'captured' outcome, ungated", async () => {
		const calls = mockFetch({ ok: true, json: {} });

		const result = await ingestRaw({
			content: "bookmark body",
			sourceId: "sess:precompact:4",
			sourceKind: "claude-precompact",
			expiresAt: "2026-07-01T00:00:00Z",
			type: "log",
			topics: ["compaction-bookmark", "echo"],
			memoryType: "episodic",
		});

		expect(result.outcome).toBe("captured");
		expect(result.gated).toBe(false);
		expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

		// Body shape owned by the seam, not the caller.
		expect(calls[0].body).toMatchObject({
			content: "bookmark body",
			source_id: "sess:precompact:4",
			source_kind: "claude-precompact",
			expires_at: "2026-07-01T00:00:00Z",
			metadata: { type: "log", topics: ["compaction-bookmark", "echo"], memory_type: "episodic" },
		});
	});

	it("omits expires_at when not provided", async () => {
		const calls = mockFetch({ ok: true, json: {} });

		await ingestRaw({ content: "x", sourceId: "s:1", sourceKind: "k" });

		expect(calls[0].body).not.toHaveProperty("expires_at");
	});

	it("maps server-side dedup to the 'duplicate' outcome", async () => {
		mockFetch({ ok: true, json: { skipped: "duplicate" } });

		const result = await ingestRaw({ content: "x", sourceId: "s:1", sourceKind: "k" });

		expect(result.outcome).toBe("duplicate");
	});

	it("never throws — an HTTP failure becomes the 'error' outcome", async () => {
		mockFetch({ ok: false, status: 500, text: "boom" });

		const result = await ingestRaw({ content: "x", sourceId: "s:1", sourceKind: "k" });

		expect(result.outcome).toBe("error");
		expect(result.reason).toContain("500");
	});
});

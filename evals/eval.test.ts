import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ai } from "@shared/model.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { evalQueries, isRelevant, loadEvalFile, ndcgAtK } from "./eval.ts";

describe("ndcgAtK", () => {
	it("is 1 when every retrieved relevant hit is ranked first", () => {
		expect(ndcgAtK([1, 1, 0, 0], 10)).toBe(1);
	});

	it("is 0 when nothing relevant surfaced", () => {
		expect(ndcgAtK([0, 0, 0], 10)).toBe(0);
		expect(ndcgAtK([], 10)).toBe(0);
	});

	it("penalizes relevant hits ranked lower", () => {
		const early = ndcgAtK([1, 0, 0, 0], 10);
		const late = ndcgAtK([0, 0, 0, 1], 10);
		expect(early).toBe(1);
		expect(late).toBeLessThan(early);
		expect(late).toBeGreaterThan(0);
	});

	it("only scores the first k ranks", () => {
		// The relevant hit sits at rank 4 — invisible at k=3.
		expect(ndcgAtK([0, 0, 0, 1], 3)).toBe(0);
	});
});

describe("isRelevant", () => {
	const hit = { id: "f6235e76-aaaa-bbbb-cccc-121212121212", content: "Works at Engine remotely" };

	it("matches case-insensitive substrings of id or content", () => {
		expect(isRelevant(hit, ["f6235e76"])).toBe(true);
		expect(isRelevant(hit, ["engine"])).toBe(true);
		expect(isRelevant(hit, ["nowhere", "REMOTELY"])).toBe(true);
	});

	it("rejects non-matches and empty relevant lists", () => {
		expect(isRelevant(hit, ["convex"])).toBe(false);
		expect(isRelevant(hit, [])).toBe(false);
	});
});

describe("evalQueries", () => {
	const dir = mkdtempSync(join(tmpdir(), "echo-eval-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const fakeAi: Ai = {
		generate: async () => "{}",
		embed: async () => [0.1, 0.2, 0.3],
	};

	function fakeDeps(hitsByQuery: Record<string, { id: string; content: string }[]>) {
		const db = {
			rpc: async (_name: string, args: Record<string, unknown>) => ({
				data: (hitsByQuery[args.query_text as string] ?? []).map((h) => ({
					...h,
					metadata: { memory_type: "fact" },
					similarity: 0.9,
					created_at: new Date().toISOString(),
					event_at: null,
					due_at: null,
					priority: null,
					category: null,
					parent_id: null,
					is_bundle: false,
				})),
				error: null,
			}),
			from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }),
		};
		return { db: db as unknown as SupabaseClient, ai: fakeAi };
	}

	function writeQueries(name: string, queries: unknown): string {
		const path = join(dir, name);
		writeFileSync(path, JSON.stringify({ queries }));
		return path;
	}

	it("scores each query through the search path and averages the metrics", async () => {
		const file = writeQueries("ok.json", [
			{ query: "perfect", relevant: ["match"] },
			{ query: "miss", relevant: ["match"] },
		]);
		const deps = fakeDeps({
			perfect: [{ id: "t1", content: "a match" }],
			miss: [{ id: "t2", content: "unrelated" }],
		});

		const summary = await evalQueries(deps, file);

		expect(summary.results).toHaveLength(2);
		expect(summary.results[0]).toMatchObject({ ndcg10: 1, hitRate3: 1, relevantInTop10: 1 });
		expect(summary.results[1]).toMatchObject({ ndcg10: 0, hitRate3: 0, relevantInTop10: 0 });
		expect(summary.meanNdcg10).toBe(0.5);
		expect(summary.meanHitRate3).toBe(0.5);
	});

	it("rejects files without a queries array", () => {
		const path = join(dir, "bad.json");
		writeFileSync(path, JSON.stringify({ nope: true }));
		expect(() => loadEvalFile(path)).toThrow('eval file must have a "queries" array');
	});
});

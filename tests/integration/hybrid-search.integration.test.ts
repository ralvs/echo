/**
 * hybrid_search RPC (migration 00008) ranking-fusion regressions, run against
 * a local `supabase start` stack. Skip-safe: skipped when the stack is down.
 *
 * Embeddings are deterministic spike vectors — cosine similarity is exactly
 * the spike overlap, so every score is computable by hand:
 *   score = alpha * cosine + (1 - alpha) * ts_rank_cd(search_vector, tsquery, 32)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	blendVector,
	deleteTagged,
	probeLocalStack,
	seedThoughts,
	serviceClient,
	spikeVector,
} from "./local-stack.ts";

const ready = await probeLocalStack();
if (!ready)
	console.warn("[integration] local supabase stack unreachable — skipping hybrid_search suite");

const TAG = `hybrid-${Date.now()}`;
const db = serviceClient();

type Hit = { id: string; content: string; similarity: number };

async function search(
	queryEmbedding: number[],
	queryText: string,
	opts: { threshold?: number; filter?: Record<string, unknown> } = {},
): Promise<Hit[]> {
	const { data, error } = await db.rpc("hybrid_search", {
		query_text: queryText,
		query_embedding: queryEmbedding,
		match_threshold: opts.threshold ?? 0.5,
		match_count: 10,
		alpha: 0.7,
		filter: opts.filter ?? { test_tag: TAG },
	});
	if (error) throw new Error(`hybrid_search failed: ${error.message}`);
	return data as Hit[];
}

let ids: string[] = [];

describe.skipIf(!ready)("hybrid_search ranking fusion", () => {
	beforeAll(async () => {
		// Spike 0 is the "query topic"; zebra is the FTS keyword.
		ids = await seedThoughts(db, TAG, [
			// [0] both rankers: high vector sim AND contains the keyword
			{ content: "notes about the zebra enclosure", embedding: blendVector(0, 1, 0.9) },
			// [1] vector only: same sim, no keyword
			{ content: "notes about the giraffe enclosure", embedding: blendVector(0, 1, 0.9) },
			// [2] FTS only: orthogonal vector, contains the keyword
			{ content: "the zebra crossed the road", embedding: spikeVector(2) },
			// [3] neither: orthogonal vector, no keyword — must never surface
			{ content: "quarterly budget spreadsheet", embedding: spikeVector(3) },
			// [4] below-threshold vector (0.4 < 0.5), no keyword — excluded
			{ content: "vaguely related musing", embedding: blendVector(0, 4, 0.4) },
		]);
	});

	afterAll(async () => {
		await deleteTagged(db, TAG);
	});

	it("OR semantics: returns vector matches and FTS matches, never noise", async () => {
		const hits = await search(spikeVector(0), "zebra");
		const returned = hits.map((h) => h.id);

		expect(returned).toContain(ids[0]); // both
		expect(returned).toContain(ids[1]); // vector only
		expect(returned).toContain(ids[2]); // FTS only
		expect(returned).not.toContain(ids[3]); // neither
	});

	it("fusion: a hit matched by both rankers outranks an equal vector-only hit", async () => {
		const hits = await search(spikeVector(0), "zebra");
		const rank = (id: string) => hits.findIndex((h) => h.id === id);

		expect(rank(ids[0])).toBeGreaterThanOrEqual(0);
		expect(rank(ids[0])).toBeLessThan(rank(ids[1]));
		// Identical cosine, so the gap is exactly the (1-alpha) * ts_rank term.
		const both = hits[rank(ids[0])];
		const vectorOnly = hits[rank(ids[1])];
		expect(both.similarity).toBeGreaterThan(vectorOnly.similarity);
		expect(vectorOnly.similarity).toBeCloseTo(0.7 * 0.9, 5);
	});

	it("threshold: vector sim at 0.4 is excluded at 0.5 and included at 0.3", async () => {
		const strict = await search(spikeVector(0), "nomatchword");
		expect(strict.map((h) => h.id)).not.toContain(ids[4]);

		const loose = await search(spikeVector(0), "nomatchword", { threshold: 0.3 });
		expect(loose.map((h) => h.id)).toContain(ids[4]);
	});

	it("descending score order and metadata containment filter hold", async () => {
		const hits = await search(spikeVector(0), "zebra");
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i].similarity).toBeLessThanOrEqual(hits[i - 1].similarity);
		}
		// Only tagged rows came back (the filter arg is @> containment).
		const { data } = await db.from("thoughts").select("id").eq("metadata->>test_tag", TAG);
		const tagged = new Set((data as { id: string }[]).map((r) => r.id));
		for (const h of hits) expect(tagged.has(h.id)).toBe(true);
	});
});

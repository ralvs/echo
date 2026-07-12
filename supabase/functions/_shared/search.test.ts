import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Ai } from "./model.ts";
import { type RawSearchResult, searchThoughts } from "./search.ts";

const fakeAi: Ai = {
	generate: async () => "{}",
	embed: async () => [0.1, 0.2, 0.3],
};

function hit(overrides: Partial<RawSearchResult>): RawSearchResult {
	return {
		id: "t1",
		content: "a thought",
		metadata: { memory_type: "fact" },
		similarity: 0.9,
		created_at: new Date().toISOString(),
		event_at: null,
		due_at: null,
		priority: null,
		category: null,
		parent_id: null,
		is_bundle: false,
		...overrides,
	};
}

/**
 * Fake of the Supabase surface the search read path crosses: the three
 * search RPCs and the parent-content lookup.
 */
function createFakeDb(opts: {
	hits?: RawSearchResult[];
	hybridError?: string;
	topicPages?: Record<string, unknown>[];
	entityPages?: Record<string, unknown>[];
	pagesThrow?: boolean;
	parents?: { id: string; content: string }[];
}) {
	const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

	const db = {
		rpc: async (name: string, args: Record<string, unknown>) => {
			rpcCalls.push({ name, args });
			if (name === "hybrid_search") {
				if (opts.hybridError) return { data: null, error: { message: opts.hybridError } };
				return { data: opts.hits ?? [], error: null };
			}
			if (opts.pagesThrow) throw new Error("pages rpc down");
			if (name === "search_topic_pages") return { data: opts.topicPages ?? [], error: null };
			if (name === "search_entity_pages") return { data: opts.entityPages ?? [], error: null };
			return { data: null, error: null };
		},
		from: (table: string) => ({
			select: () => ({
				in: async () => ({
					data: table === "thoughts" ? (opts.parents ?? []) : [],
					error: null,
				}),
			}),
		}),
	};

	return { db: db as unknown as SupabaseClient, rpcCalls };
}

describe("searchThoughts", () => {
	it("excludes bundles and sorts by decay-adjusted similarity", async () => {
		const tenMonthsAgo = new Date(Date.now() - 10 * 30 * 24 * 3600 * 1000).toISOString();
		const { db } = createFakeDb({
			hits: [
				hit({ id: "bundle", is_bundle: true }),
				// Old episodic at 0.9 decays to 0.9 * 0.5 = 0.45 — below the fresh fact
				hit({
					id: "old-episodic",
					similarity: 0.9,
					created_at: tenMonthsAgo,
					metadata: { memory_type: "episodic" },
				}),
				hit({ id: "fresh-fact", similarity: 0.6, metadata: { memory_type: "fact" } }),
			],
		});

		const { results } = await searchThoughts({ db, ai: fakeAi }, "query");

		expect(results.map((r) => r.id)).toEqual(["fresh-fact", "old-episodic"]);
	});

	it("injects parent bundle content into decomposed children", async () => {
		const { db } = createFakeDb({
			hits: [hit({ id: "child", parent_id: "p1" }), hit({ id: "solo" })],
			parents: [{ id: "p1", content: "the original capture" }],
		});

		const { results } = await searchThoughts({ db, ai: fakeAi }, "query");

		expect(results.find((r) => r.id === "child")?.parentContent).toBe("the original capture");
		expect(results.find((r) => r.id === "solo")?.parentContent).toBeUndefined();
	});

	it("returns topic and entity page preambles alongside results", async () => {
		const { db } = createFakeDb({
			hits: [hit({})],
			topicPages: [
				{ title: "Plumbing", summary: "pipes", updated_at: "2026-01-01", thought_count: 4 },
			],
			entityPages: [
				{
					title: "Sarah",
					entity_type: "person",
					summary: "colleague",
					updated_at: "2026-01-02",
					thought_count: 3,
				},
			],
		});

		const { pages } = await searchThoughts({ db, ai: fakeAi }, "query");

		expect(pages).toHaveLength(2);
		expect(pages[0]).toMatchObject({ kind: "topic", title: "Plumbing", thoughtCount: 4 });
		expect(pages[1]).toMatchObject({ kind: "entity", title: "Sarah", entityType: "person" });
	});

	it("skips page fetches when there are no results or when disabled", async () => {
		const empty = createFakeDb({ hits: [] });
		await searchThoughts({ db: empty.db, ai: fakeAi }, "query");
		expect(empty.rpcCalls.map((c) => c.name)).toEqual(["hybrid_search"]);

		const disabled = createFakeDb({ hits: [hit({})] });
		await searchThoughts({ db: disabled.db, ai: fakeAi }, "query", { includePages: false });
		expect(disabled.rpcCalls.map((c) => c.name)).toEqual(["hybrid_search"]);
	});

	it("still returns results when the page preamble RPCs fail", async () => {
		const { db } = createFakeDb({ hits: [hit({})], pagesThrow: true });

		const { results, pages } = await searchThoughts({ db, ai: fakeAi }, "query");

		expect(results).toHaveLength(1);
		expect(pages).toEqual([]);
	});

	it("throws on hybrid_search errors so adapters can report them", async () => {
		const { db } = createFakeDb({ hybridError: "boom" });

		await expect(searchThoughts({ db, ai: fakeAi }, "query")).rejects.toThrow(
			"hybrid_search failed: boom",
		);
	});

	it("owns the tuning knobs — alpha and default threshold come from the module", async () => {
		const { db, rpcCalls } = createFakeDb({ hits: [] });

		await searchThoughts({ db, ai: fakeAi }, "query");

		// match_count over-fetches (candidate pool) so post-SQL decay reranking
		// can promote rows the raw blend ranked below the requested limit.
		expect(rpcCalls[0].args).toMatchObject({ alpha: 0.7, match_threshold: 0.5, match_count: 30 });
	});

	it("slices the reranked pool back down to the requested limit", async () => {
		const now = new Date().toISOString();
		const hits = Array.from({ length: 15 }, (_, i) => ({
			id: `t${i}`,
			content: `thought ${i}`,
			metadata: {},
			similarity: 0.9 - i * 0.01,
			created_at: now,
			event_at: null,
			due_at: null,
			priority: null,
			category: null,
			parent_id: null,
			is_bundle: false,
		}));
		const { db } = createFakeDb({ hits });

		const { results } = await searchThoughts({ db, ai: fakeAi }, "query", { limit: 10 });

		expect(results).toHaveLength(10);
	});
});

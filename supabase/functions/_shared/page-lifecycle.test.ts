import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { recompileEntityPage } from "./entity-pages.ts";
import type { Ai } from "./model.ts";
import { writeCompiledPage } from "./page-lifecycle.ts";
import { updateTopicPagesForThought } from "./topic-pages.ts";

type Row = Record<string, unknown>;

function fakeAi() {
	const embedded: string[] = [];
	const ai: Ai = {
		generate: async () => "compiled summary",
		embed: async (text: string) => {
			embedded.push(text);
			return [1, 2, 3];
		},
	};
	return { ai, embedded };
}

/**
 * Fake of the Supabase surface the page lifecycle crosses. Query chains
 * resolve to `rows(table)`; single() resolves to the first row; upserts
 * and deletes are recorded for assertions.
 */
function fakeDb(opts: {
	rows?: (table: string) => Row[];
	rpc?: (name: string) => unknown;
	upsertError?: string;
}) {
	const upserts: { table: string; row: Row; options: Row }[] = [];
	const deletes: string[] = [];

	const db = {
		from(table: string) {
			const chain: Record<string, unknown> = {};
			const self = () => chain;
			for (const m of ["select", "eq", "contains", "in", "or", "order", "limit", "gte"]) {
				chain[m] = self;
			}
			chain.single = async () => ({ data: opts.rows?.(table)?.[0] ?? null, error: null });
			// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
			chain.then = (resolve: (v: { data: Row[]; error: null }) => void) => {
				resolve({ data: opts.rows?.(table) ?? [], error: null });
			};
			chain.upsert = async (row: Row, options: Row) => {
				upserts.push({ table, row, options });
				return { error: opts.upsertError ? { message: opts.upsertError } : null };
			};
			chain.delete = () => ({
				eq: async () => {
					deletes.push(table);
					return { error: null };
				},
			});
			return chain;
		},
		rpc: async (name: string) => ({ data: opts.rpc?.(name) ?? null, error: null }),
	};

	return { db: db as unknown as SupabaseClient, upserts, deletes };
}

describe("writeCompiledPage", () => {
	it("embeds the summary under its title and upserts with source bookkeeping", async () => {
		const { ai, embedded } = fakeAi();
		const { db, upserts } = fakeDb({});

		const result = await writeCompiledPage(
			{ db, ai },
			{
				table: "topic_pages",
				conflictKey: "slug",
				key: { slug: "plumbing" },
				title: "Plumbing",
				compile: async () => "compiled summary",
				thoughtIds: ["a", "b", "c"],
				extra: { entity_type: "tool" },
			},
		);

		expect(embedded).toEqual(["Plumbing\n\ncompiled summary"]);
		expect(result).toEqual({ summary: "compiled summary", thought_count: 3 });
		expect(upserts).toHaveLength(1);
		expect(upserts[0].row).toMatchObject({
			slug: "plumbing",
			title: "Plumbing",
			summary: "compiled summary",
			embedding: [1, 2, 3],
			thought_ids: ["a", "b", "c"],
			thought_count: 3,
			entity_type: "tool",
		});
		expect(upserts[0].options).toEqual({ onConflict: "slug" });
	});

	it("throws on write errors so callers choose how to absorb them", async () => {
		const { ai } = fakeAi();
		const { db } = fakeDb({ upsertError: "boom" });

		await expect(
			writeCompiledPage(
				{ db, ai },
				{
					table: "entity_pages",
					conflictKey: "entity_id",
					key: { entity_id: "e1" },
					title: "Sarah",
					compile: async () => "s",
					thoughtIds: [],
				},
			),
		).rejects.toThrow("entity_pages write failed: boom");
	});
});

describe("updateTopicPagesForThought (topic adapter)", () => {
	const THOUGHTS: Row[] = [
		{ id: "a", content: "one", created_at: "2026-01-01", metadata: {} },
		{ id: "b", content: "two", created_at: "2026-01-02", metadata: {} },
		{ id: "c", content: "three", created_at: "2026-01-03", metadata: {} },
	];

	it("creates a page once a topic crosses the creation threshold", async () => {
		const { ai } = fakeAi();
		const { db, upserts } = fakeDb({
			rows: (table) => (table === "thoughts" ? THOUGHTS : []),
			rpc: (name) => (name === "count_thoughts_for_topic" ? 3 : null),
		});

		await updateTopicPagesForThought({ db, ai }, "c", "three", [1, 2, 3], "2026-01-03", [
			"plumbing",
		]);

		expect(upserts).toHaveLength(1);
		expect(upserts[0].table).toBe("topic_pages");
		expect(upserts[0].row).toMatchObject({
			slug: "plumbing",
			title: "Plumbing",
			thought_ids: ["a", "b", "c"],
			thought_count: 3,
		});
	});

	it("does nothing below the creation threshold", async () => {
		const { ai } = fakeAi();
		const { db, upserts } = fakeDb({
			rpc: (name) => (name === "count_thoughts_for_topic" ? 2 : null),
		});

		await updateTopicPagesForThought({ db, ai }, "c", "x", [1, 2, 3], "2026-01-03", ["plumbing"]);

		expect(upserts).toHaveLength(0);
	});

	it("updates an existing page incrementally but skips already-compiled thoughts", async () => {
		const page: Row = {
			id: "p1",
			slug: "plumbing",
			title: "Plumbing",
			embedding: [1, 2, 3],
			summary: "existing",
			thought_ids: ["a", "b"],
			thought_count: 2,
		};
		const { ai } = fakeAi();
		const { db, upserts } = fakeDb({ rows: (t) => (t === "topic_pages" ? [page] : []) });

		// New thought: appended to the page's sources
		await updateTopicPagesForThought({ db, ai }, "c", "three", [1, 2, 3], "2026-01-03", [
			"plumbing",
		]);
		expect(upserts).toHaveLength(1);
		expect(upserts[0].row).toMatchObject({ thought_ids: ["a", "b", "c"], thought_count: 3 });

		// Already-compiled thought: no write
		await updateTopicPagesForThought({ db, ai }, "a", "one", [1, 2, 3], "2026-01-01", ["plumbing"]);
		expect(upserts).toHaveLength(1);
	});
});

describe("recompileEntityPage (entity adapter)", () => {
	it("deletes a stale page when the entity drops below the threshold", async () => {
		const { ai } = fakeAi();
		const { db, upserts, deletes } = fakeDb({
			rows: (table) => {
				if (table === "entities") return [{ id: "e1", type: "person", canonical_name: "Sarah" }];
				if (table === "thought_entities") return [{ thought_id: "a" }, { thought_id: "b" }];
				return [];
			},
		});

		const result = await recompileEntityPage({ db, ai }, "e1");

		expect(result).toBeNull();
		expect(deletes).toEqual(["entity_pages"]);
		expect(upserts).toHaveLength(0);
	});

	it("compiles and upserts the page with entity columns above the threshold", async () => {
		const { ai, embedded } = fakeAi();
		const { db, upserts } = fakeDb({
			rows: (table) => {
				if (table === "entities") return [{ id: "e1", type: "person", canonical_name: "Sarah" }];
				if (table === "thought_entities")
					return [{ thought_id: "a" }, { thought_id: "b" }, { thought_id: "c" }];
				if (table === "thoughts")
					return [
						{ id: "a", content: "one", created_at: "2026-01-01" },
						{ id: "b", content: "two", created_at: "2026-01-02" },
						{ id: "c", content: "three", created_at: "2026-01-03" },
					];
				return []; // entity_edges
			},
		});

		const result = await recompileEntityPage({ db, ai }, "e1");

		expect(result).toEqual({ title: "Sarah", entity_type: "person", thought_count: 3 });
		expect(embedded).toEqual(["Sarah\n\ncompiled summary"]);
		expect(upserts[0].table).toBe("entity_pages");
		expect(upserts[0].row).toMatchObject({
			entity_id: "e1",
			entity_type: "person",
			thought_count: 3,
		});
		expect(upserts[0].options).toEqual({ onConflict: "entity_id" });
	});
});

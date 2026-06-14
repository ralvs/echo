import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { corpusGraph, egoGraph } from "./relation-graph.ts";

type Row = Record<string, unknown>;

const THOUGHTS: Row[] = [
	{
		id: "c",
		content: "center",
		metadata: { type: "task" },
		created_at: "3",
		event_at: null,
		category: null,
	},
	{
		id: "a",
		content: "alpha",
		metadata: { type: "idea" },
		created_at: "2",
		event_at: null,
		category: null,
	},
	{ id: "b", content: "beta", metadata: {}, created_at: "1", event_at: null, category: null },
	{
		id: "d",
		content: "delta (isolated)",
		metadata: {},
		created_at: "0",
		event_at: null,
		category: null,
	},
];

const RELATIONS: Row[] = [
	{ source_id: "c", target_id: "a", relation_type: "related", confidence: 0.9, is_latest: true },
	{ source_id: "b", target_id: "c", relation_type: "extends", confidence: 0.8, is_latest: true },
	// dangling (x is not a thought) and superseded
	{ source_id: "c", target_id: "x", relation_type: "updates", confidence: 0.7, is_latest: false },
	// neighbour-to-neighbour — only reachable at depth 2
	{ source_id: "a", target_id: "b", relation_type: "related", confidence: 0.6, is_latest: true },
];

function matchesOr(row: Row, filter: string): boolean {
	return filter.split(",").some((clause) => {
		const [col, op, val] = clause.split(".");
		if (op === "is" && val === "null") return row[col] == null;
		return String(row[col]) === val;
	});
}

function createFakeDb() {
	const builder = (rows: Row[]) => {
		const eqs: [string, unknown][] = [];
		let orFilter: string | null = null;
		let inSet: [string, unknown[]] | null = null;
		const run = () => {
			let out = [...rows];
			for (const [col, val] of eqs) out = out.filter((r) => r[col] === val);
			if (orFilter) out = out.filter((r) => matchesOr(r, orFilter as string));
			if (inSet) {
				const [col, vals] = inSet;
				out = out.filter((r) => vals.includes(r[col]));
			}
			return out;
		};
		const self = {
			select: () => self,
			eq: (col: string, val: unknown) => {
				eqs.push([col, val]);
				return self;
			},
			or: (f: string) => {
				orFilter = f;
				return self;
			},
			in: (col: string, vals: unknown[]) => {
				inSet = [col, vals];
				return self;
			},
			order: () => self,
			limit: () => self,
			maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
			// biome-ignore lint/suspicious/noThenProperty: supabase-js builders are awaitable; the fake must be too
			then(resolve: (v: { data: Row[]; error: null }) => void) {
				resolve({ data: run(), error: null });
			},
		};
		return self;
	};

	const db = {
		from: (table: string) => builder(table === "thoughts" ? THOUGHTS : RELATIONS),
	};
	return db as unknown as SupabaseClient;
}

describe("egoGraph", () => {
	it("returns null when the centre thought is missing", async () => {
		expect(await egoGraph(createFakeDb(), "missing")).toBe(null);
	});

	it("collects the centre and its direct neighbours, dropping dangling edges", async () => {
		const graph = await egoGraph(createFakeDb(), "c", { depth: 1 });
		expect(graph).not.toBe(null);
		if (!graph) return;

		expect(new Set(graph.nodes.map((n) => n.id))).toEqual(new Set(["c", "a", "b"]));
		// c→x is dropped (x absent); a→b is not reachable at depth 1.
		expect(graph.edges).toHaveLength(2);
		expect(graph.edges.every((e) => e.source_id === "c" || e.target_id === "c")).toBe(true);
	});

	it("drops superseded relations when latestOnly is set", async () => {
		const graph = await egoGraph(createFakeDb(), "c", { depth: 1, latestOnly: true });
		expect(graph?.edges.some((e) => e.is_latest === false)).toBe(false);
	});

	it("pulls neighbour-to-neighbour edges at depth 2", async () => {
		const graph = await egoGraph(createFakeDb(), "c", { depth: 2 });
		if (!graph) return;
		const extended = graph.edges.filter((e) => e.source_id !== "c" && e.target_id !== "c");
		expect(extended.map((e) => `${e.source_id}->${e.target_id}`)).toEqual(["a->b"]);
	});
});

describe("corpusGraph", () => {
	it("returns recent thoughts plus latest edges, keeping isolated nodes", async () => {
		const graph = await corpusGraph(createFakeDb());
		expect(graph.nodes).toHaveLength(4); // includes the isolated d
		// Only latest edges with both endpoints present.
		expect(graph.edges).toHaveLength(3);
		expect(graph.edges.some((e) => e.is_latest === false)).toBe(false);
	});
});

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { type EntityGraph, entityGraph, toWeightedGraph } from "./entity-graph.ts";

type Row = Record<string, unknown>;

const ENTITIES: Row[] = [
	{ id: "e1", type: "person", canonical_name: "Sarah", mention_count: 5 },
	{ id: "e2", type: "organization", canonical_name: "Acme", mention_count: 3 },
	{ id: "e3", type: "project", canonical_name: "Project X", mention_count: 4 },
	{ id: "e4", type: "tool", canonical_name: "Orphan", mention_count: 1 },
];

const EDGES: Row[] = [
	{ source_id: "e1", target_id: "e2", weight: 5 },
	{ source_id: "e2", target_id: "e3", weight: 3 },
	{ source_id: "e1", target_id: "e3", weight: 1 }, // weak
	{ source_id: "e2", target_id: "ghost", weight: 2 }, // dangling (ghost is not an entity)
];

function createFakeDb() {
	const builder = (rows: Row[]) => {
		const gtes: [string, number][] = [];
		const run = () => {
			let out = [...rows];
			for (const [col, min] of gtes) out = out.filter((r) => (r[col] as number) >= min);
			return out;
		};
		const self = {
			select: () => self,
			gte: (col: string, min: number) => {
				gtes.push([col, min]);
				return self;
			},
			// biome-ignore lint/suspicious/noThenProperty: supabase-js builders are awaitable; the fake must be too
			then(resolve: (v: { data: Row[]; error: null }) => void) {
				resolve({ data: run(), error: null });
			},
		};
		return self;
	};
	const db = {
		from: (table: string) => builder(table === "entities" ? ENTITIES : EDGES),
	};
	return db as unknown as SupabaseClient;
}

describe("entityGraph", () => {
	it("projects every entity and drops dangling edges", async () => {
		const graph = await entityGraph(createFakeDb());
		expect(new Set(graph.nodes.map((n) => n.id))).toEqual(new Set(["e1", "e2", "e3", "e4"]));
		// e2—ghost is dropped (ghost absent); the three intra-set edges remain.
		expect(graph.edges).toHaveLength(3);
		expect(graph.edges.some((e) => e.target_id === "ghost")).toBe(false);
	});

	it("honours the minWeight floor", async () => {
		const graph = await entityGraph(createFakeDb(), { minWeight: 3 });
		// Drops the weight-1 e1—e3 tie and the weight-2 dangling edge.
		expect(graph.edges).toHaveLength(2);
		expect(graph.edges.every((e) => e.weight >= 3)).toBe(true);
	});

	it("carries display fields onto the nodes", async () => {
		const graph = await entityGraph(createFakeDb());
		const sarah = graph.nodes.find((n) => n.id === "e1");
		expect(sarah).toEqual({ id: "e1", name: "Sarah", type: "person", mention_count: 5 });
	});
});

describe("toWeightedGraph", () => {
	it("flattens an EntityGraph to the neutral id-only shape", () => {
		const graph: EntityGraph = {
			nodes: [{ id: "e1", name: "Sarah", type: "person", mention_count: 5 }],
			edges: [{ source_id: "e1", target_id: "e2", weight: 4 }],
		};
		expect(toWeightedGraph(graph)).toEqual({
			nodes: ["e1"],
			edges: [{ source: "e1", target: "e2", weight: 4 }],
		});
	});
});

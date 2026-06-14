import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { findContradictions, findDuplicates, findOrphans, findStaleFacts } from "./lint.ts";
import type { Ai } from "./model.ts";

type Row = Record<string, unknown>;

type FakeData = {
	orphans?: Row[];
	relations?: Row[];
	facts?: Row[];
	staleRows?: Row[];
	dupes?: Row[] | null;
	dupesError?: { message: string } | null;
};

function createFakeDb(data: FakeData = {}) {
	const chain = (resolve: (cols: string) => Row[]) => {
		let cols = "";
		const self = {
			select: (c?: string) => {
				cols = c ?? "";
				return self;
			},
			eq: () => self,
			lt: () => self,
			is: () => self,
			in: () => self,
			or: () => self,
			limit: () => self,
			// biome-ignore lint/suspicious/noThenProperty: supabase-js builders are awaitable; the fake must be too
			then(cb: (v: { data: Row[]; error: null }) => void) {
				cb({ data: resolve(cols), error: null });
			},
		};
		return self;
	};

	const db = {
		from: (table: string) =>
			chain((cols) => {
				if (table === "thought_relations") return data.relations ?? [];
				if (cols.includes("thought_relations")) return data.staleRows ?? [];
				if (cols.includes("metadata")) return data.facts ?? [];
				return data.orphans ?? [];
			}),
		rpc: async () =>
			data.dupesError
				? { data: null, error: data.dupesError }
				: { data: data.dupes ?? [], error: null },
	};
	return db as unknown as SupabaseClient;
}

describe("findOrphans", () => {
	it("excludes episodic thoughts that have any relation", async () => {
		const db = createFakeDb({
			orphans: [
				{ id: "o1", content: "connected", created_at: "2026-01-01" },
				{ id: "o2", content: "truly orphaned", created_at: "2026-01-02" },
			],
			relations: [{ source_id: "o1", target_id: "z" }],
		});

		const result = await findOrphans(db, 10);
		expect(result.map((t) => t.id)).toEqual(["o2"]);
	});

	it("returns nothing when there are no candidates", async () => {
		expect(await findOrphans(createFakeDb({ orphans: [] }), 10)).toEqual([]);
	});
});

describe("findStaleFacts", () => {
	it("keeps only facts whose every update relation is superseded", async () => {
		const db = createFakeDb({
			staleRows: [
				{
					id: "fully-stale",
					content: "old address",
					created_at: "2026-01-01",
					thought_relations: [{ relation_type: "updates", is_latest: false }],
				},
				{
					id: "still-current",
					content: "has a latest update",
					created_at: "2026-01-02",
					thought_relations: [
						{ relation_type: "updates", is_latest: false },
						{ relation_type: "updates", is_latest: true },
					],
				},
				{
					id: "no-updates",
					content: "never updated",
					created_at: "2026-01-03",
					thought_relations: [{ relation_type: "related", is_latest: true }],
				},
			],
		});

		const result = await findStaleFacts(db, 10);
		expect(result.map((t) => t.id)).toEqual(["fully-stale"]);
	});
});

describe("findDuplicates", () => {
	it("surfaces the RPC error instead of throwing", async () => {
		const db = createFakeDb({ dupesError: { message: "rpc boom" } });
		const result = await findDuplicates(db, 10);
		expect(result).toEqual({ pairs: [], error: "rpc boom" });
	});

	it("returns the duplicate pairs on success", async () => {
		const db = createFakeDb({
			dupes: [{ thought_a: "a", thought_b: "b", content_a: "x", content_b: "y", similarity: 0.97 }],
		});
		const result = await findDuplicates(db, 10);
		expect(result.error).toBeUndefined();
		expect(result.pairs).toHaveLength(1);
	});
});

describe("findContradictions", () => {
	it("clusters facts by topic and returns the LLM's contradictions", async () => {
		const ai: Ai = {
			async generate() {
				return JSON.stringify({
					contradictions: [{ thought_a: "f1", thought_b: "f2", explanation: "two addresses" }],
				});
			},
			async embed() {
				return [];
			},
		};
		const db = createFakeDb({
			facts: [
				{ id: "f1", content: "I live at 1 Main St", metadata: { topics: ["address"] } },
				{ id: "f2", content: "I live at 9 Oak Ave", metadata: { topics: ["address"] } },
			],
		});

		const result = await findContradictions({ db, ai }, 10);
		expect(result).toEqual([{ thought_a: "f1", thought_b: "f2", explanation: "two addresses" }]);
	});
});

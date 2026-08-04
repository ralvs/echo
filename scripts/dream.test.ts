import type { DreamInput } from "@shared/dream.ts";
import type { Ai } from "@shared/model.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { runDream } from "./dream.ts";

type Row = Record<string, unknown>;

/**
 * Minimal chainable stub — just enough of the supabase-js query builder
 * shape for dream()'s health probe (thoughts.select().in().order().limit())
 * and writeDreamReport's source_id lookup (thoughts.select().eq().limit()).
 * checks: [] on every DreamInput below means lintThoughts never queries the
 * db, so nothing else needs to be simulated.
 */
function chain(rows: Row[]) {
	const self = {
		eq(col: string, val: unknown) {
			return chain(rows.filter((r) => r[col] === val));
		},
		in(_col: string, _vals: unknown[]) {
			return chain(rows);
		},
		or(_expr: string) {
			return chain(rows);
		},
		order() {
			return chain(rows);
		},
		limit(n: number) {
			return chain(rows.slice(0, n));
		},
		single: async () =>
			rows.length
				? { data: rows[0], error: null }
				: { data: null, error: { message: "not found" } },
		maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
		// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
		then(resolve: (v: { data: Row[]; error: null }) => void) {
			resolve({ data: rows, error: null });
		},
	};
	return self;
}

function createFakeDb(existingSourceIds: string[] = []) {
	const thoughts: Row[] = existingSourceIds.map((sourceId, i) => ({
		id: `existing-${i}`,
		source_id: sourceId,
	}));
	const inserted: Row[] = [];
	let idCounter = 0;

	const db = {
		from(table: string) {
			return {
				select: (_cols?: string) => chain(table === "thoughts" ? thoughts : []),
				insert: (row: Row) => {
					const saved = { ...row, id: `new-${++idCounter}` };
					if (table === "thoughts") {
						inserted.push(saved);
						thoughts.push(saved);
					}
					return { select: () => ({ single: async () => ({ data: saved, error: null }) }) };
				},
			};
		},
		rpc: async () => ({ data: null, error: null }),
	};

	return { db: db as unknown as SupabaseClient, inserted, thoughts };
}

const fakeAi: Ai = {
	async generate() {
		return "{}";
	},
	async generateWithUsage() {
		return { text: "{}", usage: { inputTokens: 0, outputTokens: 0 } };
	},
	async embed() {
		return [0.1, 0.2, 0.3];
	},
};

function makeInput(now: Date): DreamInput {
	return {
		turns: [],
		window: { from: now.toISOString(), to: now.toISOString() },
		now,
		checks: [],
	};
}

describe("runDream", () => {
	it("--dry-run writes nothing", async () => {
		const { db, inserted } = createFakeDb();

		const outcome = await runDream(
			{ db, ai: fakeAi },
			makeInput(new Date("2026-08-04T07:30:00Z")),
			{ dryRun: true, force: false },
		);

		expect(outcome.write).toBeNull();
		expect(inserted).toHaveLength(0);
	});

	it("persists a dream report under the manual date+minute source_id when not a dry run", async () => {
		const { db, inserted } = createFakeDb();

		const outcome = await runDream(
			{ db, ai: fakeAi },
			makeInput(new Date("2026-08-04T07:30:00Z")),
			{ dryRun: false, force: false },
		);

		expect(outcome.write).toEqual({
			sourceId: "dream:2026-08-04T0730",
			id: "new-1",
			duplicate: false,
		});
		expect(inserted).toHaveLength(1);
	});

	it("reports a duplicate (does not write again) when the manual source_id already exists", async () => {
		const { db, inserted } = createFakeDb(["dream:2026-08-04T0730"]);

		const outcome = await runDream(
			{ db, ai: fakeAi },
			makeInput(new Date("2026-08-04T07:30:00Z")),
			{ dryRun: false, force: false },
		);

		expect(outcome.write?.duplicate).toBe(true);
		expect(inserted).toHaveLength(0);
	});

	it("--force appends a :r<n> suffix and writes a new revision instead of reporting a duplicate", async () => {
		const { db, inserted } = createFakeDb(["dream:2026-08-04T0730"]);

		const outcome = await runDream(
			{ db, ai: fakeAi },
			makeInput(new Date("2026-08-04T07:30:00Z")),
			{ dryRun: false, force: true },
		);

		expect(outcome.write).toEqual({
			sourceId: "dream:2026-08-04T0730:r2",
			id: "new-1",
			duplicate: false,
		});
		expect(inserted).toHaveLength(1);
	});
});

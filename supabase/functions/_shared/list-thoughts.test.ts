import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIST_COLUMNS, listThoughts } from "./list-thoughts.ts";

type Call = { method: string; args: unknown[] };

/** Records every chained call so tests assert the query the module builds. */
function recordingDb(opts: { rows?: Record<string, unknown>[]; error?: string } = {}) {
	const calls: Call[] = [];

	const chain: Record<string, unknown> = {};
	for (const m of [
		"select",
		"or",
		"limit",
		"order",
		"contains",
		"eq",
		"gte",
		"lte",
		"lt",
		"not",
		"is",
	]) {
		chain[m] = (...args: unknown[]) => {
			calls.push({ method: m, args });
			return chain;
		};
	}
	// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
	chain.then = (resolve: (v: { data: unknown; error: unknown }) => void) => {
		resolve({
			data: opts.error ? null : (opts.rows ?? []),
			error: opts.error ? { message: opts.error } : null,
		});
	};

	const db = { from: () => chain };
	const called = (method: string) => calls.filter((c) => c.method === method);
	return { db: db as unknown as SupabaseClient, calls, called };
}

describe("listThoughts", () => {
	it("always excludes bundle parents and defaults to newest-first", async () => {
		const { db, called } = recordingDb();

		await listThoughts(db);

		expect(called("or")[0].args).toEqual(["is_bundle.is.null,is_bundle.eq.false"]);
		expect(called("select")[0].args).toEqual([DEFAULT_LIST_COLUMNS]);
		expect(called("order")[0].args).toEqual(["created_at", { ascending: false }]);
	});

	it("builds the JSONB and column filter chain from the filter object", async () => {
		const { db, called } = recordingDb();

		await listThoughts(db, {
			limit: 5,
			type: "task",
			topic: "plumbing",
			person: "Sarah",
			status: "open",
			project: "echo",
			category: "home",
			minPriority: 2,
			recurring: true,
		});

		expect(called("limit")[0].args).toEqual([5]);
		const contains = called("contains").map((c) => c.args[1]);
		expect(contains).toEqual([
			{ type: "task" },
			{ topics: ["plumbing"] },
			{ people: ["Sarah"] },
			{ status: "open" },
			{ project: "echo" },
		]);
		expect(called("eq")[0].args).toEqual(["category", "home"]);
		expect(called("gte")[0].args).toEqual(["priority", 2]);
		expect(called("not")[0].args).toEqual(["recurrence", "is", null]);
	});

	it("expresses due windows: overdue means past-due and still open", async () => {
		const { db, called } = recordingDb();

		await listThoughts(db, { overdue: true, dueWithinDays: 7, orderBy: "due_at" });

		expect(called("lt")[0].args[0]).toBe("due_at");
		expect(called("contains")[0].args[1]).toEqual({ status: "open" });
		expect(called("gte")[0].args[0]).toBe("due_at");
		expect(called("lte")[0].args[0]).toBe("due_at");
		expect(called("order")[0].args).toEqual(["due_at", { ascending: true, nullsFirst: false }]);
	});

	it("returns rows and throws on query errors", async () => {
		const ok = recordingDb({ rows: [{ id: "a" }] });
		await expect(listThoughts(ok.db)).resolves.toEqual([{ id: "a" }]);

		const bad = recordingDb({ error: "boom" });
		await expect(listThoughts(bad.db)).rejects.toThrow("thoughts query failed: boom");
	});
});

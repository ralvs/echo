import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { formatThoughtStats, getThoughtStats } from "./stats.ts";
import type { ThoughtStats } from "./types.ts";

const STATS: ThoughtStats = {
	total: 42,
	dateRange: { from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
	types: { observation: 20, task: 15, idea: 7 },
	topics: { plumbing: 5, echo: 12 },
	people: { Sarah: 3 },
	categories: {},
	overdueCount: 2,
	recurringCount: 4,
};

describe("getThoughtStats", () => {
	it("returns the typed RPC result", async () => {
		const db = {
			rpc: async (name: string) => {
				expect(name).toBe("get_thought_stats");
				return { data: STATS, error: null };
			},
		} as unknown as SupabaseClient;

		expect(await getThoughtStats(db)).toEqual(STATS);
	});

	it("throws on RPC failure", async () => {
		const db = {
			rpc: async () => ({ data: null, error: { message: "boom" } }),
		} as unknown as SupabaseClient;

		await expect(getThoughtStats(db)).rejects.toThrow("Stats query failed: boom");
	});
});

describe("formatThoughtStats", () => {
	it("renders counts sorted descending and skips empty sections", () => {
		const text = formatThoughtStats(STATS);

		expect(text).toContain("Total thoughts: 42");
		expect(text).toContain("Recurring: 4");
		expect(text).toContain("Overdue: 2");
		// Sorted descending within a section.
		expect(text.indexOf("observation: 20")).toBeLessThan(text.indexOf("task: 15"));
		expect(text.indexOf("echo: 12")).toBeLessThan(text.indexOf("plumbing: 5"));
		expect(text).not.toContain("Categories:");
	});

	it("handles an empty corpus", () => {
		const text = formatThoughtStats({
			total: 0,
			dateRange: null,
			types: {},
			topics: {},
			people: {},
			categories: {},
			overdueCount: 0,
			recurringCount: 0,
		});

		expect(text).toContain("Total thoughts: 0");
		expect(text).toContain("Date range: N/A");
	});
});

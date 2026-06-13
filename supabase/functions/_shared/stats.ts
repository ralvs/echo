/**
 * Thought statistics — one implementation behind both adapters. The
 * aggregation rules live in the get_thought_stats RPC (SQL is the single
 * source of truth; it resolves people to canonical names via the people
 * table). This module types the RPC and owns the text rendering, so the
 * MCP tool and the REST /api/stats route can never disagree on the rules.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ThoughtStats } from "./types.ts";

const TOP_N = 10;

export async function getThoughtStats(db: SupabaseClient): Promise<ThoughtStats> {
	const { data, error } = await db.rpc("get_thought_stats");
	if (error) throw new Error(`Stats query failed: ${error.message}`);
	return data as ThoughtStats;
}

function top(counts: Record<string, number>, n: number = TOP_N): [string, number][] {
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, n);
}

export function formatThoughtStats(stats: ThoughtStats): string {
	const lines: string[] = [
		`Total thoughts: ${stats.total}`,
		`Date range: ${
			stats.dateRange
				? `${new Date(stats.dateRange.from).toLocaleDateString()} → ${new Date(
						stats.dateRange.to,
					).toLocaleDateString()}`
				: "N/A"
		}`,
		`Recurring: ${stats.recurringCount}`,
		`Overdue: ${stats.overdueCount}`,
		"",
		"Types:",
		...top(stats.types).map(([k, v]) => `  ${k}: ${v}`),
	];

	if (Object.keys(stats.categories).length) {
		lines.push("", "Categories:");
		for (const [k, v] of top(stats.categories)) lines.push(`  ${k}: ${v}`);
	}

	if (Object.keys(stats.topics).length) {
		lines.push("", "Top topics:");
		for (const [k, v] of top(stats.topics)) lines.push(`  ${k}: ${v}`);
	}

	if (Object.keys(stats.people).length) {
		lines.push("", "People mentioned:");
		for (const [k, v] of top(stats.people)) lines.push(`  ${k}: ${v}`);
	}

	return lines.join("\n");
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { supabase } from "../config.ts";

export function registerThoughtStats(server: McpServer) {
	server.registerTool(
		"thought_stats",
		{
			title: "Thought Statistics",
			description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
			inputSchema: {},
		},
		async () => {
			try {
				const { count } = await supabase
					.from("thoughts")
					.select("*", { count: "exact", head: true })
					.or("is_bundle.is.null,is_bundle.eq.false");

				const { data } = await supabase
					.from("thoughts")
					.select("metadata, created_at, category, priority, due_at, recurrence")
					.or("is_bundle.is.null,is_bundle.eq.false")
					.order("created_at", { ascending: false });

				const types: Record<string, number> = {};
				const topics: Record<string, number> = {};
				const people: Record<string, number> = {};
				const categories: Record<string, number> = {};
				let overdueCount = 0;
				let recurringCount = 0;
				const now = new Date();

				for (const r of data || []) {
					const m = (r.metadata || {}) as Record<string, unknown>;
					if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
					if (Array.isArray(m.topics))
						for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
					if (Array.isArray(m.people))
						for (const p of m.people) {
							const name = typeof p === "string" ? p : (p as Record<string, unknown>)?.name;
							if (typeof name === "string" && name)
								people[name as string] = (people[name as string] || 0) + 1;
						}
					if (r.category) categories[r.category] = (categories[r.category] || 0) + 1;
					if (r.recurrence) recurringCount++;
					if (r.due_at && new Date(r.due_at) < now && m.status === "open") overdueCount++;
				}

				const sort = (o: Record<string, number>): [string, number][] =>
					Object.entries(o)
						.sort((a, b) => b[1] - a[1])
						.slice(0, 10);

				const lines: string[] = [
					`Total thoughts: ${count}`,
					`Date range: ${
						data?.length
							? new Date(data[data.length - 1].created_at).toLocaleDateString() +
								" → " +
								new Date(data[0].created_at).toLocaleDateString()
							: "N/A"
					}`,
					`Recurring: ${recurringCount}`,
					`Overdue: ${overdueCount}`,
					"",
					"Types:",
					...sort(types).map(([k, v]) => `  ${k}: ${v}`),
				];

				if (Object.keys(categories).length) {
					lines.push("", "Categories:");
					for (const [k, v] of sort(categories)) lines.push(`  ${k}: ${v}`);
				}

				if (Object.keys(topics).length) {
					lines.push("", "Top topics:");
					for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
				}

				if (Object.keys(people).length) {
					lines.push("", "People mentioned:");
					for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (err: unknown) {
				return {
					content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}

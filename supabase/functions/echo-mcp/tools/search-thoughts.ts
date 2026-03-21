import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { supabase, PRIORITY_LABELS } from "../config.ts";
import { getEmbedding } from "../ai.ts";

export function registerSearchThoughts(server: McpServer) {
	server.registerTool(
		"search_thoughts",
		{
			title: "Search Thoughts",
			description:
				"Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
			inputSchema: {
				query: z.string().describe("What to search for"),
				limit: z.number().optional().default(10),
				threshold: z.number().optional().default(0.5),
			},
		},
		async ({ query, limit, threshold }) => {
			try {
				const qEmb = await getEmbedding(query);
				const { data, error } = await supabase.rpc("match_thoughts", {
					query_embedding: qEmb,
					match_threshold: threshold,
					match_count: limit,
					filter: {},
				});

				if (error) {
					return {
						content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
						isError: true,
					};
				}

				// Exclude bundle parents from search results
				const filtered = (data || []).filter(
					(t: { is_bundle?: boolean }) => !t.is_bundle,
				);

				if (filtered.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
					};
				}

				const results = filtered.map(
					(
						t: {
							id: string;
							content: string;
							metadata: Record<string, unknown>;
							similarity: number;
							created_at: string;
							due_at: string | null;
							priority: number | null;
							category: string | null;
						},
						i: number,
					) => {
						const m = t.metadata || {};
						const parts = [
							`--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
							`ID: ${t.id}`,
							`Captured: ${new Date(t.created_at).toLocaleDateString()}`,
							`Type: ${m.type || "unknown"}`,
						];
						if (m.status) parts.push(`Status: ${m.status}`);
						if (t.category) parts.push(`Category: ${t.category}`);
						if (t.priority && t.priority > 0) parts.push(`Priority: ${PRIORITY_LABELS[t.priority] || t.priority}`);
						if (t.due_at) parts.push(`Due: ${new Date(t.due_at).toLocaleDateString()}`);
						if (Array.isArray(m.topics) && m.topics.length)
							parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
						if (Array.isArray(m.people) && m.people.length)
							parts.push(`People: ${(m.people as string[]).join(", ")}`);
						if (Array.isArray(m.action_items) && m.action_items.length)
							parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
						parts.push(`\n${t.content}`);
						return parts.join("\n");
					},
				);

				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${filtered.length} thought(s):\n\n${results.join("\n\n")}`,
						},
					],
				};
			} catch (err: unknown) {
				return {
					content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}

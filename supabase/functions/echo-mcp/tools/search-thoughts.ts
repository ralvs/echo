import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEmbedding } from "../ai.ts";
import { PRIORITY_LABELS, supabase } from "../config.ts";
import { applyDecay, type RawSearchResult } from "../search-assembly.ts";

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
				const { data, error } = await supabase.rpc("hybrid_search", {
					query_text: query,
					query_embedding: qEmb,
					match_threshold: threshold,
					match_count: limit,
					alpha: 0.7,
					filter: {},
				});

				if (error) {
					return {
						content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
						isError: true,
					};
				}

				const raw = (data || []) as RawSearchResult[];
				const filtered = applyDecay(raw.filter((t) => !t.is_bundle));

				// Batch-fetch parent content for decomposed children
				const parentIds = [
					...new Set(filtered.filter((t) => t.parent_id).map((t) => t.parent_id!)),
				];
				let parentMap: Record<string, string> = {};
				if (parentIds.length) {
					const { data: parents } = await supabase
						.from("thoughts")
						.select("id, content")
						.in("id", parentIds);
					if (parents) {
						parentMap = Object.fromEntries(
							parents.map((p: { id: string; content: string }) => [p.id, p.content]),
						);
					}
				}

				if (filtered.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
					};
				}

				// Fetch relevant topic pages as a compiled preamble
				let topicPreamble = "";
				try {
					const { data: pages } = await supabase.rpc("search_topic_pages", {
						query_text: query,
						query_embedding: qEmb,
						match_threshold: 0.5,
						match_count: 2,
					});
					if (pages?.length) {
						topicPreamble = pages
							.map(
								(p: {
									title: string;
									summary: string;
									updated_at: string;
									thought_count: number;
								}) =>
									`╔═ Topic Page: ${p.title} (${p.thought_count} thoughts, updated ${new Date(p.updated_at).toLocaleDateString()}) ═╗\n${p.summary}\n╚══════════════════════════════════════════════════════╝`,
							)
							.join("\n\n");
					}
				} catch {
					// Non-blocking — search results are still returned even if preamble fails
				}

				// Fetch relevant entity pages (graph-backed) as additional preamble
				let entityPreamble = "";
				try {
					const { data: pages } = await supabase.rpc("search_entity_pages", {
						query_text: query,
						query_embedding: qEmb,
						match_threshold: 0.5,
						match_count: 2,
					});
					if (pages?.length) {
						entityPreamble = pages
							.map(
								(p: {
									title: string;
									entity_type: string;
									summary: string;
									updated_at: string;
									thought_count: number;
								}) =>
									`╔═ ${`${p.entity_type[0].toUpperCase()}${p.entity_type.slice(1)}`} Page: ${p.title} (${p.thought_count} thoughts, updated ${new Date(p.updated_at).toLocaleDateString()}) ═╗\n${p.summary}\n╚══════════════════════════════════════════════════════╝`,
							)
							.join("\n\n");
					}
				} catch {
					// Non-blocking
				}

				const preamble = [topicPreamble, entityPreamble].filter(Boolean).join("\n\n");

				const results = filtered.map((t, i) => {
					const m = t.metadata || {};
					const parts = [
						`--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
						`ID: ${t.id}`,
						`Captured: ${new Date(t.created_at).toLocaleDateString()}`,
						`Type: ${m.type || "unknown"}`,
					];
					if (t.event_at) parts.push(`Event: ${new Date(t.event_at).toLocaleDateString()}`);
					if (m.memory_type) parts.push(`Memory: ${m.memory_type}`);
					if (m.status) parts.push(`Status: ${m.status}`);
					if (t.category) parts.push(`Category: ${t.category}`);
					if (t.priority && t.priority > 0)
						parts.push(`Priority: ${PRIORITY_LABELS[t.priority] || t.priority}`);
					if (t.due_at) parts.push(`Due: ${new Date(t.due_at).toLocaleDateString()}`);
					if (Array.isArray(m.topics) && m.topics.length)
						parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
					if (Array.isArray(m.people) && m.people.length)
						parts.push(`People: ${(m.people as string[]).join(", ")}`);
					if (Array.isArray(m.action_items) && m.action_items.length)
						parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
					if (t.parent_id && parentMap[t.parent_id]) {
						const parentContent = parentMap[t.parent_id];
						const parentPreview =
							parentContent.length > 200 ? parentContent.substring(0, 200) + "..." : parentContent;
						parts.push(`Original context: ${parentPreview}`);
					}
					parts.push(`\n${t.content}`);
					return parts.join("\n");
				});

				const header = preamble
					? `${preamble}\n\n--- Individual Results (${filtered.length}) ---\n\n`
					: `Found ${filtered.length} thought(s):\n\n`;

				return {
					content: [
						{
							type: "text" as const,
							text: `${header}${results.join("\n\n")}`,
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

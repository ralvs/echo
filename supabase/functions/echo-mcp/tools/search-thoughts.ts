import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type PagePreamble, searchThoughts, type ThoughtHit } from "../../_shared/search.ts";
import { PRIORITY_LABELS, supabase } from "../config.ts";
import { ai } from "../model.ts";

function formatPage(p: PagePreamble): string {
	const label =
		p.kind === "entity" && p.entityType
			? `${p.entityType[0].toUpperCase()}${p.entityType.slice(1)} Page`
			: "Topic Page";
	return `╔═ ${label}: ${p.title} (${p.thoughtCount} thoughts, updated ${new Date(p.updatedAt).toLocaleDateString()}) ═╗\n${p.summary}\n╚══════════════════════════════════════════════════════╝`;
}

function formatHit(t: ThoughtHit, index: number): string {
	const m = t.metadata || {};
	const parts = [
		`--- Result ${index + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
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
	if (t.parentContent) {
		const preview =
			t.parentContent.length > 200 ? `${t.parentContent.substring(0, 200)}...` : t.parentContent;
		parts.push(`Original context: ${preview}`);
	}
	parts.push(`\n${t.content}`);
	return parts.join("\n");
}

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
				const { results, pages } = await searchThoughts({ db: supabase, ai }, query, {
					limit,
					threshold,
				});

				if (results.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
					};
				}

				const preamble = pages.map(formatPage).join("\n\n");
				const header = preamble
					? `${preamble}\n\n--- Individual Results (${results.length}) ---\n\n`
					: `Found ${results.length} thought(s):\n\n`;

				return {
					content: [
						{
							type: "text" as const,
							text: `${header}${results.map(formatHit).join("\n\n")}`,
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

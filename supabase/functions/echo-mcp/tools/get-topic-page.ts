import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "../config.ts";

export function registerGetTopicPage(server: McpServer) {
	server.registerTool(
		"get_topic_page",
		{
			title: "Get Topic Page",
			description:
				"Retrieve a compiled topic page by slug (e.g. 'home-plumbing') or ID. Returns the full LLM-compiled summary plus the list of source thought IDs.",
			inputSchema: {
				slug: z.string().optional().describe("Topic slug, e.g. 'home-plumbing'"),
				id: z.string().optional().describe("Topic page UUID"),
			},
		},
		async ({ slug, id }) => {
			try {
				if (!slug && !id) {
					return {
						content: [{ type: "text" as const, text: "Error: provide either slug or id." }],
						isError: true,
					};
				}

				const query = supabase
					.from("topic_pages")
					.select("id, slug, title, summary, thought_ids, thought_count, updated_at, created_at");

				const { data, error } = await (id ? query.eq("id", id) : query.eq("slug", slug!)).single();

				if (error || !data) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Topic page not found: ${slug ?? id}`,
							},
						],
						isError: true,
					};
				}

				const parts = [
					`# ${data.title}`,
					`Slug: ${data.slug} | ID: ${data.id}`,
					`Sources: ${data.thought_count} thought(s) | Last updated: ${new Date(data.updated_at).toLocaleDateString()}`,
					``,
					data.summary,
					``,
					`Source thought IDs: ${(data.thought_ids as string[]).join(", ")}`,
				];

				return {
					content: [{ type: "text" as const, text: parts.join("\n") }],
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

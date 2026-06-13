import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "../config.ts";
import { registerTextTool, ToolError } from "./contract.ts";

export function registerGetTopicPage(server: McpServer) {
	registerTextTool(
		server,
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
			if (!slug && !id) {
				throw new ToolError("Error: provide either slug or id.");
			}

			const query = supabase
				.from("topic_pages")
				.select("id, slug, title, summary, thought_ids, thought_count, updated_at, created_at");

			const { data, error } = await (id
				? query.eq("id", id)
				: query.eq("slug", slug ?? "")
			).single();

			if (error || !data) {
				throw new ToolError(`Topic page not found: ${slug ?? id}`);
			}

			return [
				`# ${data.title}`,
				`Slug: ${data.slug} | ID: ${data.id}`,
				`Sources: ${data.thought_count} thought(s) | Last updated: ${new Date(data.updated_at).toLocaleDateString()}`,
				``,
				data.summary,
				``,
				`Source thought IDs: ${(data.thought_ids as string[]).join(", ")}`,
			].join("\n");
		},
	);
}

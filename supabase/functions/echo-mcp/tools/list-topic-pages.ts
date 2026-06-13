import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "../config.ts";
import { registerTextTool, ToolError } from "./contract.ts";

export function registerListTopicPages(server: McpServer) {
	registerTextTool(
		server,
		"list_topic_pages",
		{
			title: "List Topic Pages",
			description:
				"List all compiled topic pages — pre-synthesized knowledge summaries automatically maintained from captured thoughts. Each page represents a topic where 3+ thoughts have been captured.",
			inputSchema: {
				limit: z.number().optional().default(20).describe("Max number of pages to return"),
				order_by: z
					.enum(["updated_at", "thought_count", "title"])
					.optional()
					.default("updated_at")
					.describe("Sort order"),
			},
		},
		async ({ limit, order_by }) => {
			const { data, error } = await supabase
				.from("topic_pages")
				.select("id, slug, title, thought_count, updated_at, created_at")
				.order(order_by, { ascending: order_by === "title" })
				.limit(limit);

			if (error) throw new ToolError(`Error: ${error.message}`);

			if (!data?.length) {
				return "No topic pages yet. Capture 3+ thoughts on the same topic to create one.";
			}

			const lines = data.map(
				(p: {
					id: string;
					slug: string;
					title: string;
					thought_count: number;
					updated_at: string;
					created_at: string;
				}) =>
					`• ${p.title} [${p.slug}] — ${p.thought_count} thought(s) | updated ${new Date(p.updated_at).toLocaleDateString()} | ID: ${p.id}`,
			);

			return `${data.length} topic page(s):\n\n${lines.join("\n")}`;
		},
	);
}

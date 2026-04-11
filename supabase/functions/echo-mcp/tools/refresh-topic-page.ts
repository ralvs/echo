import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recompileTopicPage } from "../topic-pages.ts";

export function registerRefreshTopicPage(server: McpServer) {
	server.registerTool(
		"refresh_topic_page",
		{
			title: "Refresh Topic Page",
			description:
				"Force a full recompilation of a topic page from all its source thoughts. Use this when the page summary feels stale or after updating several source thoughts. Slower than the incremental update that happens automatically on capture.",
			inputSchema: {
				id: z.string().describe("Topic page UUID to recompile"),
			},
		},
		async ({ id }) => {
			try {
				const result = await recompileTopicPage(id);
				return {
					content: [
						{
							type: "text" as const,
							text: `Recompiled "${result.title}" [${result.slug}] from ${result.thought_count} source thought(s).`,
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

import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recompileEntityPage } from "../entity-pages.ts";

export function registerRefreshEntityPage(server: McpServer) {
	server.registerTool(
		"refresh_entity_page",
		{
			title: "Refresh Entity Page",
			description:
				"Force a full recompilation of an entity's wiki page from all its linked thoughts and co-occurrence edges. Use after updating several source thoughts, or to build a page on demand. Returns the recompiled page's thought count.",
			inputSchema: {
				entity_id: z.string().describe("Entity UUID to recompile a page for"),
			},
		},
		async ({ entity_id }) => {
			try {
				const result = await recompileEntityPage(entity_id);
				if (!result) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No page written for ${entity_id} — entity not found or below the 3-thought threshold.`,
							},
						],
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Recompiled ${result.entity_type} page "${result.title}" from ${result.thought_count} linked thought(s).`,
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatThoughtStats, getThoughtStats } from "../../_shared/stats.ts";
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
				const stats = await getThoughtStats(supabase);
				return { content: [{ type: "text" as const, text: formatThoughtStats(stats) }] };
			} catch (err: unknown) {
				return {
					content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}

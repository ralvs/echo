import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatThoughtStats, getThoughtStats } from "../../_shared/stats.ts";
import { supabase } from "../config.ts";
import { registerTextTool } from "./contract.ts";

export function registerThoughtStats(server: McpServer) {
	registerTextTool(
		server,
		"thought_stats",
		{
			title: "Thought Statistics",
			description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
			inputSchema: {},
		},
		async () => formatThoughtStats(await getThoughtStats(supabase)),
	);
}

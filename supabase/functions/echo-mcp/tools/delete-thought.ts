import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { supabase } from "../config.ts";

export function registerDeleteThought(server: McpServer) {
	server.registerTool(
		"delete_thought",
		{
			title: "Delete Thought",
			description:
				"Permanently delete a thought and all its version history. Use this to remove outdated, incorrect, or duplicate thoughts.",
			inputSchema: {
				id: z.string().describe("UUID of the thought to delete"),
			},
		},
		async ({ id }) => {
			try {
				const { data: thought, error: fetchErr } = await supabase
					.from("thoughts")
					.select("id, content, metadata, version")
					.eq("id", id)
					.single();

				if (fetchErr || !thought) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Thought not found: ${fetchErr?.message || "no matching ID"}`,
							},
						],
						isError: true,
					};
				}

				const { error: deleteErr } = await supabase.from("thoughts").delete().eq("id", id);

				if (deleteErr) {
					return {
						content: [{ type: "text" as const, text: `Failed to delete: ${deleteErr.message}` }],
						isError: true,
					};
				}

				const m = (thought.metadata || {}) as Record<string, unknown>;
				const preview =
					thought.content.length > 100
						? thought.content.substring(0, 100) + "..."
						: thought.content;

				return {
					content: [
						{
							type: "text" as const,
							text: `Deleted thought ${id} (v${thought.version}, ${m.type || "unknown"}):\n"${preview}"`,
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

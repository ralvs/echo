import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "../config.ts";
import { preview, registerTextTool, ToolError } from "./contract.ts";

export function registerDeleteThought(server: McpServer) {
	registerTextTool(
		server,
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
			const { data: thought, error: fetchErr } = await supabase
				.from("thoughts")
				.select("id, content, metadata, version")
				.eq("id", id)
				.single();

			if (fetchErr || !thought) {
				throw new ToolError(`Thought not found: ${fetchErr?.message || "no matching ID"}`);
			}

			const { error: deleteErr } = await supabase.from("thoughts").delete().eq("id", id);
			if (deleteErr) throw new ToolError(`Failed to delete: ${deleteErr.message}`);

			const m = (thought.metadata || {}) as Record<string, unknown>;
			return `Deleted thought ${id} (v${thought.version}, ${m.type || "unknown"}):\n"${preview(thought.content, 100)}"`;
		},
	);
}

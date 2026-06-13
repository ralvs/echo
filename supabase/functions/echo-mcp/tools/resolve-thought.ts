import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveThought } from "../../_shared/resolve.ts";
import { supabase } from "../config.ts";
import { preview, registerTextTool, ToolError } from "./contract.ts";

function contentPreview(thought: Record<string, unknown>): string {
	return preview(typeof thought.content === "string" ? thought.content : "", 80);
}

export function registerResolveThought(server: McpServer) {
	registerTextTool(
		server,
		"resolve_thought",
		{
			title: "Resolve Thought",
			description:
				"Mark a thought as resolved (done) or reopen it. For recurring thoughts, resolving archives the current version and advances the due date to the next occurrence. Works as a toggle — resolved thoughts can be reopened.",
			inputSchema: {
				id: z.string().describe("UUID of the thought to resolve or reopen"),
				status: z
					.enum(["resolved", "open"])
					.optional()
					.default("resolved")
					.describe("Set to 'resolved' to mark done, 'open' to reopen"),
			},
		},
		async ({ id, status }) => {
			const result = await resolveThought(supabase, id, status);

			switch (result.kind) {
				case "not_found":
					throw new ToolError(`Thought not found: ${result.error}`);
				case "recurrence_ended":
					return `Resolved recurring thought ${id} (recurrence ended):\n"${contentPreview(result.thought)}"`;
				case "advanced":
					return `Completed recurring thought ${id} (completion #${result.completionCount}). Next due: ${result.nextDue.toLocaleDateString()}\n"${contentPreview(result.thought)}"`;
				case "toggled": {
					const metadata = (result.thought.metadata ?? {}) as Record<string, unknown>;
					return `${result.status === "resolved" ? "Resolved" : "Reopened"} thought ${id} (${metadata.type || "unknown"}):\n"${contentPreview(result.thought)}"`;
				}
			}
		},
	);
}

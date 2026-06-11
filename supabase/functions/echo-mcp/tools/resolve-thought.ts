import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveThought } from "../../_shared/resolve.ts";
import { supabase } from "../config.ts";

function preview(thought: Record<string, unknown>): string {
	const content = typeof thought.content === "string" ? thought.content : "";
	return content.length > 80 ? `${content.substring(0, 80)}...` : content;
}

export function registerResolveThought(server: McpServer) {
	server.registerTool(
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
			try {
				const result = await resolveThought(supabase, id, status);

				switch (result.kind) {
					case "not_found":
						return {
							content: [{ type: "text" as const, text: `Thought not found: ${result.error}` }],
							isError: true,
						};
					case "recurrence_ended":
						return {
							content: [
								{
									type: "text" as const,
									text: `Resolved recurring thought ${id} (recurrence ended):\n"${preview(result.thought)}"`,
								},
							],
						};
					case "advanced":
						return {
							content: [
								{
									type: "text" as const,
									text: `Completed recurring thought ${id} (completion #${result.completionCount}). Next due: ${result.nextDue.toLocaleDateString()}\n"${preview(result.thought)}"`,
								},
							],
						};
					case "toggled": {
						const metadata = (result.thought.metadata ?? {}) as Record<string, unknown>;
						return {
							content: [
								{
									type: "text" as const,
									text: `${result.status === "resolved" ? "Resolved" : "Reopened"} thought ${id} (${metadata.type || "unknown"}):\n"${preview(result.thought)}"`,
								},
							],
						};
					}
				}
			} catch (err: unknown) {
				return {
					content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}

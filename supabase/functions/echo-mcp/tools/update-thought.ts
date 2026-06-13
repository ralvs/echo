import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateThought } from "../../_shared/update.ts";
import { supabase } from "../config.ts";
import { ai } from "../model.ts";

export function registerUpdateThought(server: McpServer) {
	server.registerTool(
		"update_thought",
		{
			title: "Update Thought",
			description:
				"Update an existing thought's content. Archives the previous version, re-extracts metadata, generates a new embedding, and runs relation detection. Use this to revise daily plans, correct notes, or evolve ideas without creating duplicates.",
			inputSchema: {
				id: z.string().describe("UUID of the thought to update"),
				content: z.string().describe("New content for the thought"),
				type: z
					.string()
					.optional()
					.describe(
						"Override type: observation, task, idea, reference, person_note, daily, log, or custom",
					),
				topics: z
					.union([z.array(z.string()), z.string()])
					.optional()
					.describe("Override topics — array of tags or comma-separated string"),
				due_at: z.string().optional().describe("Update the due date — ISO 8601 datetime"),
				recurrence: z
					.object({
						interval_days: z.number().optional(),
						unit: z.enum(["day", "week", "month"]).optional(),
						days_of_week: z.array(z.number()).optional(),
						day_of_month: z.number().optional(),
						end_at: z.string().optional(),
					})
					.optional()
					.describe("Update recurrence rule"),
				priority: z.number().optional().describe("Update priority: 0-4"),
				category: z.string().optional().describe("Update category"),
			},
		},
		async ({ id, content, type, topics, due_at, recurrence, priority, category }) => {
			try {
				const result = await updateThought(
					{ db: supabase, ai },
					id,
					{ content, type, topics, due_at, recurrence, priority, category },
					{ source: "mcp" },
				);

				if (result.kind === "not_found") {
					return {
						content: [{ type: "text" as const, text: `Thought not found: ${result.error}` }],
						isError: true,
					};
				}

				let text = `Updated thought ${id} to version ${result.thought.version}. Previous version ${result.previousVersion} archived.`;
				if (result.relations.length) text += `\nRelations: ${result.relations.join("; ")}`;
				return { content: [{ type: "text" as const, text }] };
			} catch (err: unknown) {
				return {
					content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}

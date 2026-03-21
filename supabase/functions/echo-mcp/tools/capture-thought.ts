import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DECOMPOSE_ENABLED, PRIORITY_LABELS } from "../config.ts";
import { decomposeWithLLM } from "../ai.ts";
import { shouldDecompose, saveSingleThought } from "../decompose.ts";

export function registerCaptureThought(server: McpServer) {
	server.registerTool(
		"capture_thought",
		{
			title: "Capture Thought",
			description:
				"Save a new thought to Echo. Accepts plain text, Markdown, or JSON as content. Generates an embedding and extracts metadata automatically. You may optionally provide type, topics, scheduling (due_at, recurrence, priority), and category to override auto-extracted values. Use this when the user wants to save something — notes, insights, decisions, daily plans, tasks, recurring reminders, or structured logs.",
			inputSchema: {
				content: z
					.string()
					.optional()
					.describe(
						"The thought to capture — plain text, Markdown, or JSON. A clear, standalone statement that will make sense when retrieved later by any AI",
					),
				thought: z.string().optional().describe("Alias for content — use either content or thought"),
				type: z
					.string()
					.optional()
					.describe(
						"Override auto-detected type: observation, task, idea, reference, person_note, daily, log, or any custom type",
					),
				topics: z
					.union([z.array(z.string()), z.string()])
					.optional()
					.describe("Override auto-detected topics — an array of tags or a comma-separated string"),
				due_at: z
					.string()
					.optional()
					.describe("When this thought is due — ISO 8601 datetime string (e.g. 2026-04-01T09:00:00Z)"),
				recurrence: z
					.object({
						interval_days: z.number().optional().describe("Repeat every N days"),
						unit: z.enum(["day", "week", "month"]).optional().describe("Time unit (default: day)"),
						days_of_week: z
							.array(z.number())
							.optional()
							.describe("ISO weekday numbers: 1=Mon, 7=Sun"),
						day_of_month: z.number().optional().describe("Day of month (1-28) for monthly recurrence"),
						end_at: z.string().optional().describe("Stop recurring after this ISO date"),
					})
					.optional()
					.describe("Recurrence rule for repeating tasks (e.g. {interval_days: 90} for every 90 days)"),
				priority: z
					.number()
					.optional()
					.describe("Priority level: 0=none, 1=low, 2=medium, 3=high, 4=urgent"),
				category: z
					.string()
					.optional()
					.describe("Override auto-detected category (e.g. plumbing, italian, gardening)"),
			},
		},
		async ({ content, thought, type, topics, due_at, recurrence, priority, category }) => {
			try {
				const text = content || thought;
				if (!text) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: Either 'content' or 'thought' parameter is required.",
							},
						],
						isError: true,
					};
				}

				const overrides: Record<string, unknown> = {
					type,
					topics,
					due_at,
					recurrence,
					priority,
					category,
				};

				if (!shouldDecompose(text, DECOMPOSE_ENABLED)) {
					const { id, metadata, category: savedCategory } = await saveSingleThought(text, overrides);

					let confirmation = `Captured as ${metadata.type || "thought"} (ID: ${id})`;
					if (savedCategory) confirmation += ` [${savedCategory}]`;
					if (Array.isArray(metadata.topics) && metadata.topics.length)
						confirmation += ` — ${(metadata.topics as string[]).join(", ")}`;
					if (Array.isArray(metadata.people) && metadata.people.length)
						confirmation += ` | People: ${(metadata.people as string[]).join(", ")}`;
					if (Array.isArray(metadata.action_items) && metadata.action_items.length)
						confirmation += ` | Actions: ${(metadata.action_items as string[]).join("; ")}`;
					if (due_at) confirmation += ` | Due: ${new Date(due_at).toLocaleDateString()}`;
					if (recurrence) confirmation += ` | Recurring`;
					if (priority && priority > 0) confirmation += ` | Priority: ${PRIORITY_LABELS[priority]}`;

					return {
						content: [{ type: "text" as const, text: confirmation }],
					};
				}

				// Attempt decomposition
				const atomicThoughts = await decomposeWithLLM(text);

				if (!atomicThoughts) {
					const { id, metadata, category: savedCategory } = await saveSingleThought(text, overrides);

					let confirmation = `Captured as ${metadata.type || "thought"} (ID: ${id})`;
					if (savedCategory) confirmation += ` [${savedCategory}]`;
					if (Array.isArray(metadata.topics) && metadata.topics.length)
						confirmation += ` — ${(metadata.topics as string[]).join(", ")}`;

					return {
						content: [{ type: "text" as const, text: confirmation }],
					};
				}

				// Save parent bundle + atomic children
				const parent = await saveSingleThought(text, {
					...overrides,
					type: overrides.type || "log",
					is_bundle: true,
				});

				const children: { id: string; topic: string }[] = [];
				for (const item of atomicThoughts) {
					const child = await saveSingleThought(item.content, {
						type: item.type,
						topics: [item.topic],
						category: overrides.category,
						parent_id: parent.id,
					});
					children.push({ id: child.id, topic: item.topic });
				}

				const topicList = children.map((c) => c.topic).join(", ");
				return {
					content: [
						{
							type: "text" as const,
							text: `Decomposed into ${children.length} atomic thoughts (parent: ${parent.id})\nTopics: ${topicList}`,
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

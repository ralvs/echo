import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPostCapturePipeline } from "../capture-pipeline.ts";
import { DECOMPOSE_ENABLED, PRIORITY_LABELS, supabase } from "../config.ts";
import { decompose, saveSingleThought } from "../decompose.ts";

async function insertSourceRelations(thoughtId: string, sourceIds: string[]): Promise<void> {
	for (const sourceId of sourceIds) {
		await supabase.from("thought_relations").upsert(
			{
				source_id: thoughtId,
				target_id: sourceId,
				relation_type: "derives",
				confidence: 1.0,
				is_latest: true,
			},
			{ onConflict: "source_id,target_id,relation_type" },
		);
	}
}

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
				thought: z
					.string()
					.optional()
					.describe("Alias for content — use either content or thought"),
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
					.describe(
						"When this thought is due — ISO 8601 datetime string (e.g. 2026-04-01T09:00:00Z)",
					),
				recurrence: z
					.object({
						interval_days: z.number().optional().describe("Repeat every N days"),
						unit: z.enum(["day", "week", "month"]).optional().describe("Time unit (default: day)"),
						days_of_week: z
							.array(z.number())
							.optional()
							.describe("ISO weekday numbers: 1=Mon, 7=Sun"),
						day_of_month: z
							.number()
							.optional()
							.describe("Day of month (1-28) for monthly recurrence"),
						end_at: z.string().optional().describe("Stop recurring after this ISO date"),
					})
					.optional()
					.describe(
						"Recurrence rule for repeating tasks (e.g. {interval_days: 90} for every 90 days)",
					),
				priority: z
					.number()
					.optional()
					.describe("Priority level: 0=none, 1=low, 2=medium, 3=high, 4=urgent"),
				category: z
					.string()
					.optional()
					.describe("Override auto-detected category (e.g. plumbing, italian, gardening)"),
				source_ids: z
					.array(z.string())
					.optional()
					.describe(
						"IDs of source thoughts this was derived from. Explicitly creates 'derives' relations at confidence 1.0, bypassing the automatic relation classifier.",
					),
				source_id: z
					.string()
					.optional()
					.describe(
						'External idempotency key (e.g. "<session_uuid>:<turn_index>" for a Claude Code transcript). If a thought with this source_id exists, capture is skipped.',
					),
				source_kind: z
					.string()
					.optional()
					.describe(
						'Source taxonomy label (e.g. "claude-transcript", "claude-precompact"). Used together with source_id.',
					),
			},
		},
		async ({
			content,
			thought,
			type,
			topics,
			due_at,
			recurrence,
			priority,
			category,
			source_ids,
			source_id,
			source_kind,
		}) => {
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

				if (source_id) {
					const { data: existing } = await supabase
						.from("thoughts")
						.select("id")
						.eq("source_id", source_id)
						.maybeSingle();
					if (existing) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Skipped duplicate (source_id=${source_id}, existing id=${existing.id})`,
								},
							],
						};
					}
				}

				const overrides: Record<string, unknown> = {
					type,
					topics,
					due_at,
					recurrence,
					priority,
					category,
					source_id,
					source_kind,
				};

				// Decomposition policy: single interface hides heuristic + LLM fallback
				const atomicThoughts = await decompose(text, DECOMPOSE_ENABLED);

				if (!atomicThoughts) {
					// Single thought path
					const {
						id,
						metadata,
						category: savedCategory,
						embedding,
						created_at,
					} = await saveSingleThought(text, overrides);

					if (source_ids?.length) await insertSourceRelations(id, source_ids);

					const topics = Array.isArray(metadata.topics) ? (metadata.topics as string[]) : [];
					const { relations } = await runPostCapturePipeline(
						id,
						text,
						embedding,
						created_at,
						topics,
						metadata.memory_type as string | undefined,
					);

					let confirmation = `Captured as ${metadata.type || "thought"} (ID: ${id})`;
					if (savedCategory) confirmation += ` [${savedCategory}]`;
					if (topics.length) confirmation += ` — ${topics.join(", ")}`;
					if (Array.isArray(metadata.people) && metadata.people.length)
						confirmation += ` | People: ${(metadata.people as string[]).join(", ")}`;
					if (Array.isArray(metadata.action_items) && metadata.action_items.length)
						confirmation += ` | Actions: ${(metadata.action_items as string[]).join("; ")}`;
					if (due_at) confirmation += ` | Due: ${new Date(due_at).toLocaleDateString()}`;
					if (recurrence) confirmation += ` | Recurring`;
					if (priority && priority > 0) confirmation += ` | Priority: ${PRIORITY_LABELS[priority]}`;
					if (relations.length) confirmation += `\nRelations: ${relations.join("; ")}`;

					return { content: [{ type: "text" as const, text: confirmation }] };
				}

				// Decomposed path: save parent bundle + atomic children
				const parent = await saveSingleThought(text, {
					...overrides,
					type: overrides.type || "log",
					is_bundle: true,
				});

				const children: { id: string; topic: string }[] = [];
				const allRelations: string[] = [];

				for (const item of atomicThoughts) {
					const child = await saveSingleThought(item.content, {
						type: item.type,
						topics: [item.topic],
						category: overrides.category,
						parent_id: parent.id,
					});
					children.push({ id: child.id, topic: item.topic });

					if (source_ids?.length) await insertSourceRelations(child.id, source_ids);

					const { relations } = await runPostCapturePipeline(
						child.id,
						item.content,
						child.embedding,
						child.created_at,
						[item.topic],
						child.metadata.memory_type as string | undefined,
						parent.id,
					);
					allRelations.push(...relations);
				}

				const topicList = children.map((c) => c.topic).join(", ");
				let decomposedText = `Decomposed into ${children.length} atomic thoughts (parent: ${parent.id})\nTopics: ${topicList}`;
				if (allRelations.length) {
					decomposedText += `\nRelations: ${allRelations.join("; ")}`;
				}
				return {
					content: [{ type: "text" as const, text: decomposedText }],
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

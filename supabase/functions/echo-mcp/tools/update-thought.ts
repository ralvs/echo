import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildEmbeddingText, extractMetadata, getEmbedding } from "../ai.ts";
import { supabase } from "../config.ts";
import { backfillPersonAlias, getKnownPeople, upsertPerson } from "../people.ts";

export function registerUpdateThought(server: McpServer) {
	server.registerTool(
		"update_thought",
		{
			title: "Update Thought",
			description:
				"Update an existing thought's content. Archives the previous version and generates a new embedding and metadata. Use this to revise daily plans, correct notes, or evolve ideas without creating duplicates.",
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
				const { data: current, error: fetchErr } = await supabase
					.from("thoughts")
					.select("id, content, embedding, metadata, version, created_at")
					.eq("id", id)
					.single();

				if (fetchErr || !current) {
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

				const { error: archiveErr } = await supabase.from("thought_versions").insert({
					thought_id: current.id,
					version: current.version,
					content: current.content,
					embedding: current.embedding,
					metadata: current.metadata,
					created_at: current.created_at,
				});

				if (archiveErr) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to archive version: ${archiveErr.message}`,
							},
						],
						isError: true,
					};
				}

				// Extract metadata with known people so aliases resolve to canonical names
				const knownPeople = await getKnownPeople();
				const extracted = await extractMetadata(content, knownPeople);

				const extractedCategory = extracted.category as string | null;
				const extractedPersonDefinitions = extracted.person_definitions as
					| { canonical_name: string; role: string }[]
					| undefined;
				delete extracted.category;
				delete extracted.person_definitions;

				const metadata = { ...extracted, source: "mcp" } as Record<string, unknown>;
				if (type) metadata.type = type;
				if (topics) {
					metadata.topics =
						typeof topics === "string"
							? topics
									.split(",")
									.map((t: string) => t.trim())
									.filter(Boolean)
							: topics;
				}

				const effectiveCategory = category ?? extractedCategory;
				const embeddingText = buildEmbeddingText(content, metadata, effectiveCategory);
				const embedding = await getEmbedding(embeddingText);

				const newVersion = (current.version || 1) + 1;
				const updateRow: Record<string, unknown> = {
					content,
					embedding,
					metadata,
					version: newVersion,
					updated_at: new Date().toISOString(),
				};

				if (due_at !== undefined) updateRow.due_at = due_at;
				if (recurrence !== undefined) updateRow.recurrence = recurrence;
				if (priority !== undefined) updateRow.priority = priority;
				if (category !== undefined) updateRow.category = category;
				else if (extractedCategory) updateRow.category = extractedCategory;

				const { error: updateErr } = await supabase.from("thoughts").update(updateRow).eq("id", id);

				if (updateErr) {
					return {
						content: [{ type: "text" as const, text: `Failed to update: ${updateErr.message}` }],
						isError: true,
					};
				}

				if (extractedPersonDefinitions?.length) {
					(async () => {
						for (const def of extractedPersonDefinitions) {
							try {
								const { newAliases } = await upsertPerson(def.canonical_name, def.role);
								for (const alias of newAliases) {
									backfillPersonAlias(alias, def.canonical_name).catch((e) =>
										console.error(`Backfill failed for alias "${alias}":`, e),
									);
								}
							} catch (e) {
								console.error(`Person upsert failed for "${def.canonical_name}":`, e);
							}
						}
					})().catch((e) => console.error("Person pipeline error:", e));
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Updated thought ${id} to version ${newVersion}. Previous version ${current.version} archived.`,
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

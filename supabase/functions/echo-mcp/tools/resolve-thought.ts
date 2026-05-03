import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { supabase } from "../config.ts";
import { type RecurrenceRule, calculateNextDue } from "../recurrence.ts";

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
				const { data: thought, error: fetchErr } = await supabase
					.from("thoughts")
					.select("id, content, metadata, version, embedding, created_at, due_at, recurrence")
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

				const currentMetadata = thought.metadata as Record<string, unknown>;
				const preview =
					thought.content.length > 80 ? thought.content.substring(0, 80) + "..." : thought.content;

				// Recurring thought: resolve-and-advance
				if (status === "resolved" && thought.recurrence) {
					const rule = thought.recurrence as RecurrenceRule;

					if (rule.end_at && new Date(rule.end_at) < new Date()) {
						const metadata = {
							...currentMetadata,
							status: "resolved",
							resolved_at: new Date().toISOString(),
						};

						const { error: updateErr } = await supabase
							.from("thoughts")
							.update({ metadata, updated_at: new Date().toISOString() })
							.eq("id", id);

						if (updateErr) {
							return {
								content: [
									{ type: "text" as const, text: `Failed to resolve: ${updateErr.message}` },
								],
								isError: true,
							};
						}

						return {
							content: [
								{
									type: "text" as const,
									text: `Resolved recurring thought ${id} (recurrence ended):\n"${preview}"`,
								},
							],
						};
					}

					const { error: archiveErr } = await supabase.from("thought_versions").insert({
						thought_id: thought.id,
						version: thought.version,
						content: thought.content,
						embedding: thought.embedding,
						metadata: thought.metadata,
						created_at: thought.created_at,
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

					const currentDue = thought.due_at ? new Date(thought.due_at) : new Date();
					const nextDue = calculateNextDue(currentDue, rule);

					const completionCount = ((currentMetadata.completion_count as number) || 0) + 1;
					const metadata = {
						...currentMetadata,
						status: "open",
						resolved_at: null,
						last_completed: new Date().toISOString(),
						completion_count: completionCount,
					};

					const newVersion = (thought.version || 1) + 1;
					const { error: updateErr } = await supabase
						.from("thoughts")
						.update({
							metadata,
							due_at: nextDue.toISOString(),
							version: newVersion,
							updated_at: new Date().toISOString(),
						})
						.eq("id", id);

					if (updateErr) {
						return {
							content: [{ type: "text" as const, text: `Failed to advance: ${updateErr.message}` }],
							isError: true,
						};
					}

					return {
						content: [
							{
								type: "text" as const,
								text: `Completed recurring thought ${id} (completion #${completionCount}). Next due: ${nextDue.toLocaleDateString()}\n"${preview}"`,
							},
						],
					};
				}

				// Non-recurring: simple status toggle
				const metadata = {
					...currentMetadata,
					status,
					...(status === "resolved"
						? { resolved_at: new Date().toISOString() }
						: { resolved_at: null }),
				};

				const { error: updateErr } = await supabase
					.from("thoughts")
					.update({ metadata, updated_at: new Date().toISOString() })
					.eq("id", id);

				if (updateErr) {
					return {
						content: [
							{ type: "text" as const, text: `Failed to update status: ${updateErr.message}` },
						],
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `${status === "resolved" ? "Resolved" : "Reopened"} thought ${id} (${currentMetadata.type || "unknown"}):\n"${preview}"`,
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

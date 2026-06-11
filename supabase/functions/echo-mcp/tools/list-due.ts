import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listThoughts } from "../../_shared/list-thoughts.ts";
import type { RecurrenceRule } from "../../_shared/types.ts";
import { PRIORITY_LABELS, supabase } from "../config.ts";

type DueThought = {
	id: string;
	content: string;
	metadata: Record<string, unknown>;
	due_at: string;
	priority: number | null;
	category: string | null;
	recurrence: RecurrenceRule | null;
};

function formatItem(t: DueThought): string {
	const m = t.metadata || {};
	const priorityTag = t.priority && t.priority > 0 ? ` [${PRIORITY_LABELS[t.priority]}]` : "";
	const catTag = t.category ? ` (${t.category})` : "";
	const recurTag = t.recurrence ? " ↻" : "";
	const preview = t.content.length > 80 ? `${t.content.substring(0, 80)}...` : t.content;
	return `  ${new Date(t.due_at).toLocaleDateString()}${priorityTag}${catTag}${recurTag} — ${preview}\n    ID: ${t.id} | Type: ${m.type || "unknown"}`;
}

export function registerListDue(server: McpServer) {
	server.registerTool(
		"list_due",
		{
			title: "List Due Thoughts",
			description:
				"Show overdue and upcoming thoughts sorted by due date. Use this to check what needs attention — tasks, maintenance, reminders, etc.",
			inputSchema: {
				days_ahead: z
					.number()
					.optional()
					.default(7)
					.describe("How many days ahead to look (default: 7)"),
				include_overdue: z
					.boolean()
					.optional()
					.default(true)
					.describe("Include overdue items (default: true)"),
			},
		},
		async ({ days_ahead, include_overdue }) => {
			try {
				const upcoming = await listThoughts<DueThought>(supabase, {
					dueWithinDays: days_ahead,
					orderBy: "due_at",
				});

				const overdue = include_overdue
					? await listThoughts<DueThought>(supabase, { overdue: true, orderBy: "due_at" })
					: [];

				const lines: string[] = [];

				if (overdue.length) {
					lines.push(`⚠ OVERDUE (${overdue.length}):`);
					for (const t of overdue) lines.push(formatItem(t));
					lines.push("");
				}

				if (upcoming.length) {
					lines.push(`UPCOMING (next ${days_ahead} days — ${upcoming.length}):`);
					for (const t of upcoming) lines.push(formatItem(t));
				}

				if (!overdue.length && !upcoming.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Nothing due in the next ${days_ahead} days. All clear.`,
							},
						],
					};
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
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

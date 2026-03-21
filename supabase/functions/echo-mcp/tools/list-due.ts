import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { supabase, PRIORITY_LABELS } from "../config.ts";
import { type RecurrenceRule } from "../recurrence.ts";

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
				const now = new Date();
				const until = new Date();
				until.setDate(until.getDate() + days_ahead);

				const { data: upcoming, error: upErr } = await supabase
					.from("thoughts")
					.select("id, content, metadata, due_at, priority, category, recurrence")
					.or("is_bundle.is.null,is_bundle.eq.false")
					.gte("due_at", now.toISOString())
					.lte("due_at", until.toISOString())
					.order("due_at", { ascending: true });

				if (upErr) {
					return {
						content: [{ type: "text" as const, text: `Error: ${upErr.message}` }],
						isError: true,
					};
				}

				let overdue: typeof upcoming = [];
				if (include_overdue) {
					const { data: od, error: odErr } = await supabase
						.from("thoughts")
						.select("id, content, metadata, due_at, priority, category, recurrence")
						.or("is_bundle.is.null,is_bundle.eq.false")
						.lt("due_at", now.toISOString())
						.contains("metadata", { status: "open" })
						.order("due_at", { ascending: true });

					if (odErr) {
						return {
							content: [{ type: "text" as const, text: `Error: ${odErr.message}` }],
							isError: true,
						};
					}
					overdue = od || [];
				}

				const formatItem = (
					t: {
						id: string;
						content: string;
						metadata: Record<string, unknown>;
						due_at: string;
						priority: number | null;
						category: string | null;
						recurrence: RecurrenceRule | null;
					},
				) => {
					const m = t.metadata || {};
					const priorityTag = t.priority && t.priority > 0 ? ` [${PRIORITY_LABELS[t.priority]}]` : "";
					const catTag = t.category ? ` (${t.category})` : "";
					const recurTag = t.recurrence ? " ↻" : "";
					const preview = t.content.length > 80 ? t.content.substring(0, 80) + "..." : t.content;
					return `  ${new Date(t.due_at).toLocaleDateString()}${priorityTag}${catTag}${recurTag} — ${preview}\n    ID: ${t.id} | Type: ${m.type || "unknown"}`;
				};

				const lines: string[] = [];

				if (overdue.length) {
					lines.push(`⚠ OVERDUE (${overdue.length}):`);
					for (const t of overdue) lines.push(formatItem(t));
					lines.push("");
				}

				if (upcoming?.length) {
					lines.push(`UPCOMING (next ${days_ahead} days — ${upcoming.length}):`);
					for (const t of upcoming) lines.push(formatItem(t));
				}

				if (!overdue.length && !upcoming?.length) {
					return {
						content: [{ type: "text" as const, text: `Nothing due in the next ${days_ahead} days. All clear.` }],
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

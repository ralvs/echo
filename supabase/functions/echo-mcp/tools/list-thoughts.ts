import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listThoughts } from "../../_shared/list-thoughts.ts";
import type { RecurrenceRule } from "../../_shared/types.ts";
import { PRIORITY_LABELS, supabase } from "../config.ts";

type ListedThought = {
	id: string;
	content: string;
	metadata: Record<string, unknown>;
	created_at: string;
	event_at: string | null;
	due_at: string | null;
	priority: number | null;
	category: string | null;
	recurrence: RecurrenceRule | null;
};

function formatThought(t: ListedThought, i: number): string {
	const m = t.metadata || {};
	const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
	const statusTag = m.status ? ` [${m.status}]` : "";
	const priorityTag = t.priority && t.priority > 0 ? ` P:${PRIORITY_LABELS[t.priority]}` : "";
	const dueTag = t.due_at ? ` Due:${new Date(t.due_at).toLocaleDateString()}` : "";
	const eventTag = t.event_at ? ` Event:${new Date(t.event_at).toLocaleDateString()}` : "";
	const recurTag = t.recurrence ? " ↻" : "";
	const catTag = t.category ? ` [${t.category}]` : "";
	const projectTag = m.project ? ` 📁${m.project}` : "";
	const orgTag = m.organization ? ` 🏢${m.organization}` : "";
	const sentimentTag = m.sentiment === "positive" ? " ✓" : m.sentiment === "negative" ? " ✗" : "";
	return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? ` - ${tags}` : ""})${statusTag}${priorityTag}${dueTag}${eventTag}${recurTag}${catTag}${projectTag}${orgTag}${sentimentTag}\n   ID: ${t.id}\n   ${t.content}`;
}

export function registerListThoughts(server: McpServer) {
	server.registerTool(
		"list_thoughts",
		{
			title: "List Recent Thoughts",
			description:
				"List recently captured thoughts with optional filters by type, topic, person, time range, priority, category, or due status.",
			inputSchema: {
				limit: z.number().optional().default(10),
				type: z
					.string()
					.optional()
					.describe("Filter by type: observation, task, idea, reference, person_note"),
				topic: z.string().optional().describe("Filter by topic tag"),
				person: z.string().optional().describe("Filter by person mentioned"),
				days: z.number().optional().describe("Only thoughts from the last N days"),
				status: z.string().optional().describe("Filter by status: open or resolved"),
				category: z.string().optional().describe("Filter by category"),
				priority: z
					.number()
					.optional()
					.describe("Filter by minimum priority level: 1=low, 2=medium, 3=high, 4=urgent"),
				overdue: z
					.boolean()
					.optional()
					.describe("If true, only show overdue thoughts (due_at < now)"),
				due_within_days: z.number().optional().describe("Only thoughts due within the next N days"),
				recurring: z.boolean().optional().describe("If true, only show recurring thoughts"),
				project: z.string().optional().describe("Filter by project name"),
				organization: z.string().optional().describe("Filter by organization/company name"),
				sentiment: z
					.enum(["positive", "negative", "neutral"])
					.optional()
					.describe("Filter by sentiment"),
				order_by: z
					.enum(["created_at", "due_at", "priority"])
					.optional()
					.default("created_at")
					.describe("Sort order: created_at (default), due_at, or priority"),
			},
		},
		async (input) => {
			try {
				const data = await listThoughts<ListedThought>(supabase, {
					limit: input.limit,
					type: input.type,
					topic: input.topic,
					person: input.person,
					status: input.status,
					project: input.project,
					organization: input.organization,
					sentiment: input.sentiment,
					category: input.category,
					minPriority: input.priority,
					recurring: input.recurring,
					days: input.days,
					overdue: input.overdue,
					dueWithinDays: input.due_within_days,
					orderBy: input.order_by,
				});

				if (!data.length) {
					return { content: [{ type: "text" as const, text: "No thoughts found." }] };
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `${data.length} thought(s):\n\n${data.map(formatThought).join("\n\n")}`,
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

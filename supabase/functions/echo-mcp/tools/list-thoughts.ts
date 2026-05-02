import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PRIORITY_LABELS, supabase } from "../config.ts";
import type { RecurrenceRule } from "../recurrence.ts";

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
		async ({
			limit,
			type,
			topic,
			person,
			days,
			status,
			category,
			priority,
			overdue,
			due_within_days,
			recurring,
			project,
			organization,
			sentiment,
			order_by,
		}) => {
			try {
				let q = supabase
					.from("thoughts")
					.select(
						"id, content, metadata, created_at, event_at, due_at, priority, category, recurrence",
					)
					.limit(limit);

				// Exclude bundle parents by default
				q = q.or("is_bundle.is.null,is_bundle.eq.false");

				// Sorting
				if (order_by === "due_at") {
					q = q.order("due_at", { ascending: true, nullsFirst: false });
				} else if (order_by === "priority") {
					q = q.order("priority", { ascending: false, nullsFirst: false });
				} else {
					q = q.order("created_at", { ascending: false });
				}

				// JSONB filters
				if (type) q = q.contains("metadata", { type });
				if (topic) q = q.contains("metadata", { topics: [topic] });
				if (person) q = q.contains("metadata", { people: [person] });
				if (status) q = q.contains("metadata", { status });

				if (project) q = q.contains("metadata", { project });
				if (organization) q = q.contains("metadata", { organization });
				if (sentiment) q = q.contains("metadata", { sentiment });

				// Column filters
				if (category) q = q.eq("category", category);
				if (priority) q = q.gte("priority", priority);
				if (recurring === true) q = q.not("recurrence", "is", null);
				if (recurring === false) q = q.is("recurrence", null);

				if (days) {
					const since = new Date();
					since.setDate(since.getDate() - days);
					q = q.gte("created_at", since.toISOString());
				}

				const now = new Date().toISOString();
				if (overdue) {
					q = q.lt("due_at", now).contains("metadata", { status: "open" });
				}
				if (due_within_days) {
					const until = new Date();
					until.setDate(until.getDate() + due_within_days);
					q = q.gte("due_at", now).lte("due_at", until.toISOString());
				}

				const { data, error } = await q;

				if (error) {
					return {
						content: [{ type: "text" as const, text: `Error: ${error.message}` }],
						isError: true,
					};
				}

				if (!data || !data.length) {
					return { content: [{ type: "text" as const, text: "No thoughts found." }] };
				}

				const results = data.map(
					(
						t: {
							id: string;
							content: string;
							metadata: Record<string, unknown>;
							created_at: string;
							event_at: string | null;
							due_at: string | null;
							priority: number | null;
							category: string | null;
							recurrence: RecurrenceRule | null;
						},
						i: number,
					) => {
						const m = t.metadata || {};
						const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
						const statusTag = m.status ? ` [${m.status}]` : "";
						const priorityTag =
							t.priority && t.priority > 0 ? ` P:${PRIORITY_LABELS[t.priority]}` : "";
						const dueTag = t.due_at ? ` Due:${new Date(t.due_at).toLocaleDateString()}` : "";
						const eventTag = t.event_at
							? ` Event:${new Date(t.event_at).toLocaleDateString()}`
							: "";
						const recurTag = t.recurrence ? " ↻" : "";
						const catTag = t.category ? ` [${t.category}]` : "";
						const projectTag = m.project ? ` 📁${m.project}` : "";
						const orgTag = m.organization ? ` 🏢${m.organization}` : "";
						const sentimentTag =
							m.sentiment === "positive" ? " ✓" : m.sentiment === "negative" ? " ✗" : "";
						return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? ` - ${tags}` : ""})${statusTag}${priorityTag}${dueTag}${eventTag}${recurTag}${catTag}${projectTag}${orgTag}${sentimentTag}\n   ID: ${t.id}\n   ${t.content}`;
					},
				);

				return {
					content: [
						{
							type: "text" as const,
							text: `${data.length} thought(s):\n\n${results.join("\n\n")}`,
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

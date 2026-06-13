import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureThought } from "../../_shared/capture.ts";
import { DECOMPOSE_ENABLED, DECOMPOSE_MIN_TOKENS, PRIORITY_LABELS, supabase } from "../config.ts";
import { ai } from "../model.ts";
import { registerTextTool, ToolError } from "./contract.ts";

export function registerCaptureThought(server: McpServer) {
	registerTextTool(
		server,
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
			const text = content || thought;
			if (!text) {
				throw new ToolError("Error: Either 'content' or 'thought' parameter is required.");
			}

			const result = await captureThought(
				{ db: supabase, ai },
				{
					content: text,
					type,
					topics,
					due_at,
					recurrence,
					priority,
					category,
					source_ids,
					source_id,
					source_kind,
				},
				{
					source: "mcp",
					decompose: DECOMPOSE_ENABLED,
					decomposeMinTokens: DECOMPOSE_MIN_TOKENS,
				},
			);

			if (result.kind === "duplicate") {
				return `Skipped duplicate (source_id=${result.source_id}, existing id=${result.id})`;
			}

			if (result.kind === "decomposed") {
				const topicList = result.children.map((c) => c.topic).join(", ");
				let out = `Decomposed into ${result.children.length} atomic thoughts (parent: ${result.parent.id})\nTopics: ${topicList}`;
				if (result.relations.length) out += `\nRelations: ${result.relations.join("; ")}`;
				return out;
			}

			const { thought: saved, relations } = result;
			const metadata = (saved.metadata ?? {}) as Record<string, unknown>;
			const savedTopics = Array.isArray(metadata.topics) ? (metadata.topics as string[]) : [];

			let confirmation = `Captured as ${metadata.type || "thought"} (ID: ${saved.id})`;
			if (saved.category) confirmation += ` [${saved.category}]`;
			if (savedTopics.length) confirmation += ` — ${savedTopics.join(", ")}`;
			if (Array.isArray(metadata.people) && metadata.people.length)
				confirmation += ` | People: ${(metadata.people as string[]).join(", ")}`;
			if (Array.isArray(metadata.action_items) && metadata.action_items.length)
				confirmation += ` | Actions: ${(metadata.action_items as string[]).join("; ")}`;
			if (due_at) confirmation += ` | Due: ${new Date(due_at).toLocaleDateString()}`;
			if (recurrence) confirmation += ` | Recurring`;
			if (priority && priority > 0) confirmation += ` | Priority: ${PRIORITY_LABELS[priority]}`;
			if (relations.length) confirmation += `\nRelations: ${relations.join("; ")}`;

			return confirmation;
		},
	);
}

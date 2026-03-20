import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";

import { supabase, MCP_ACCESS_KEY, DECOMPOSE_ENABLED, PRIORITY_LABELS } from "./config.ts";
import { getEmbedding, extractMetadata, decomposeWithLLM } from "./ai.ts";
import { shouldDecompose, saveSingleThought } from "./decompose.ts";
import { type RecurrenceRule, calculateNextDue } from "./recurrence.ts";

// --- MCP Server Factory (stateless: new instance per request) ---

function createServer(): McpServer {
	const server = new McpServer({
		name: "echo",
		version: "3.0.0",
	});

	// Tool 1: Semantic Search
	server.registerTool(
		"search_thoughts",
		{
			title: "Search Thoughts",
			description:
				"Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
			inputSchema: {
				query: z.string().describe("What to search for"),
				limit: z.number().optional().default(10),
				threshold: z.number().optional().default(0.5),
			},
		},
		async ({ query, limit, threshold }) => {
			try {
				const qEmb = await getEmbedding(query);
				const { data, error } = await supabase.rpc("match_thoughts", {
					query_embedding: qEmb,
					match_threshold: threshold,
					match_count: limit,
					filter: {},
				});

				if (error) {
					return {
						content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
						isError: true,
					};
				}

				// Exclude bundle parents from search results
				const filtered = (data || []).filter(
					(t: { is_bundle?: boolean }) => !t.is_bundle,
				);

				if (filtered.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
					};
				}

				const results = filtered.map(
					(
						t: {
							id: string;
							content: string;
							metadata: Record<string, unknown>;
							similarity: number;
							created_at: string;
							due_at: string | null;
							priority: number | null;
							category: string | null;
						},
						i: number,
					) => {
						const m = t.metadata || {};
						const parts = [
							`--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
							`ID: ${t.id}`,
							`Captured: ${new Date(t.created_at).toLocaleDateString()}`,
							`Type: ${m.type || "unknown"}`,
						];
						if (m.status) parts.push(`Status: ${m.status}`);
						if (t.category) parts.push(`Category: ${t.category}`);
						if (t.priority && t.priority > 0) parts.push(`Priority: ${PRIORITY_LABELS[t.priority] || t.priority}`);
						if (t.due_at) parts.push(`Due: ${new Date(t.due_at).toLocaleDateString()}`);
						if (Array.isArray(m.topics) && m.topics.length)
							parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
						if (Array.isArray(m.people) && m.people.length)
							parts.push(`People: ${(m.people as string[]).join(", ")}`);
						if (Array.isArray(m.action_items) && m.action_items.length)
							parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
						parts.push(`\n${t.content}`);
						return parts.join("\n");
					},
				);

				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${filtered.length} thought(s):\n\n${results.join("\n\n")}`,
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

	// Tool 2: List Recent
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
				status: z
					.string()
					.optional()
					.describe("Filter by status: open or resolved"),
				category: z.string().optional().describe("Filter by category"),
				priority: z
					.number()
					.optional()
					.describe("Filter by minimum priority level: 1=low, 2=medium, 3=high, 4=urgent"),
				overdue: z.boolean().optional().describe("If true, only show overdue thoughts (due_at < now)"),
				due_within_days: z.number().optional().describe("Only thoughts due within the next N days"),
				recurring: z.boolean().optional().describe("If true, only show recurring thoughts"),
				order_by: z
					.enum(["created_at", "due_at", "priority"])
					.optional()
					.default("created_at")
					.describe("Sort order: created_at (default), due_at, or priority"),
			},
		},
		async ({ limit, type, topic, person, days, status, category, priority, overdue, due_within_days, recurring, order_by }) => {
			try {
				let q = supabase
					.from("thoughts")
					.select("id, content, metadata, created_at, due_at, priority, category, recurrence")
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
						const priorityTag = t.priority && t.priority > 0 ? ` P:${PRIORITY_LABELS[t.priority]}` : "";
						const dueTag = t.due_at ? ` Due:${new Date(t.due_at).toLocaleDateString()}` : "";
						const recurTag = t.recurrence ? " ↻" : "";
						const catTag = t.category ? ` [${t.category}]` : "";
						return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})${statusTag}${priorityTag}${dueTag}${recurTag}${catTag}\n   ID: ${t.id}\n   ${t.content}`;
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

	// Tool 3: Stats
	server.registerTool(
		"thought_stats",
		{
			title: "Thought Statistics",
			description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
			inputSchema: {},
		},
		async () => {
			try {
				const { count } = await supabase
					.from("thoughts")
					.select("*", { count: "exact", head: true })
					.or("is_bundle.is.null,is_bundle.eq.false");

				const { data } = await supabase
					.from("thoughts")
					.select("metadata, created_at, category, priority, due_at, recurrence")
					.or("is_bundle.is.null,is_bundle.eq.false")
					.order("created_at", { ascending: false });

				const types: Record<string, number> = {};
				const topics: Record<string, number> = {};
				const people: Record<string, number> = {};
				const categories: Record<string, number> = {};
				let overdueCount = 0;
				let recurringCount = 0;
				const now = new Date();

				for (const r of data || []) {
					const m = (r.metadata || {}) as Record<string, unknown>;
					if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
					if (Array.isArray(m.topics))
						for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
					if (Array.isArray(m.people))
						for (const p of m.people) {
						const name = typeof p === "string" ? p : (p as Record<string, unknown>)?.name;
						if (typeof name === "string" && name) people[name as string] = (people[name as string] || 0) + 1;
					}
					if (r.category) categories[r.category] = (categories[r.category] || 0) + 1;
					if (r.recurrence) recurringCount++;
					if (r.due_at && new Date(r.due_at) < now && m.status === "open") overdueCount++;
				}

				const sort = (o: Record<string, number>): [string, number][] =>
					Object.entries(o)
						.sort((a, b) => b[1] - a[1])
						.slice(0, 10);

				const lines: string[] = [
					`Total thoughts: ${count}`,
					`Date range: ${
						data?.length
							? new Date(data[data.length - 1].created_at).toLocaleDateString() +
								" → " +
								new Date(data[0].created_at).toLocaleDateString()
							: "N/A"
					}`,
					`Recurring: ${recurringCount}`,
					`Overdue: ${overdueCount}`,
					"",
					"Types:",
					...sort(types).map(([k, v]) => `  ${k}: ${v}`),
				];

				if (Object.keys(categories).length) {
					lines.push("", "Categories:");
					for (const [k, v] of sort(categories)) lines.push(`  ${k}: ${v}`);
				}

				if (Object.keys(topics).length) {
					lines.push("", "Top topics:");
					for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
				}

				if (Object.keys(people).length) {
					lines.push("", "People mentioned:");
					for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (err: unknown) {
				return {
					content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);

	// Tool 4: Capture Thought (with auto-decomposition)
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

	// Tool 5: Update Thought
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

				const [embedding, extracted] = await Promise.all([
					getEmbedding(content),
					extractMetadata(content),
				]);

				const extractedCategory = extracted.category as string | null;
				delete extracted.category;

				const metadata = { ...extracted, source: "mcp" } as Record<string, unknown>;
				if (type) metadata.type = type;
				if (topics) {
					metadata.topics =
						typeof topics === "string"
							? topics.split(",").map((t: string) => t.trim()).filter(Boolean)
							: topics;
				}

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

				const { error: updateErr } = await supabase
					.from("thoughts")
					.update(updateRow)
					.eq("id", id);

				if (updateErr) {
					return {
						content: [{ type: "text" as const, text: `Failed to update: ${updateErr.message}` }],
						isError: true,
					};
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

	// Tool 6: Delete Thought
	server.registerTool(
		"delete_thought",
		{
			title: "Delete Thought",
			description:
				"Permanently delete a thought and all its version history. Use this to remove outdated, incorrect, or duplicate thoughts.",
			inputSchema: {
				id: z.string().describe("UUID of the thought to delete"),
			},
		},
		async ({ id }) => {
			try {
				const { data: thought, error: fetchErr } = await supabase
					.from("thoughts")
					.select("id, content, metadata, version")
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

				const { error: deleteErr } = await supabase.from("thoughts").delete().eq("id", id);

				if (deleteErr) {
					return {
						content: [{ type: "text" as const, text: `Failed to delete: ${deleteErr.message}` }],
						isError: true,
					};
				}

				const m = (thought.metadata || {}) as Record<string, unknown>;
				const preview =
					thought.content.length > 100
						? thought.content.substring(0, 100) + "..."
						: thought.content;

				return {
					content: [
						{
							type: "text" as const,
							text: `Deleted thought ${id} (v${thought.version}, ${m.type || "unknown"}):\n"${preview}"`,
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

	// Tool 7: Resolve / Reopen Thought
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
					thought.content.length > 80
						? thought.content.substring(0, 80) + "..."
						: thought.content;

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
								content: [{ type: "text" as const, text: `Failed to resolve: ${updateErr.message}` }],
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

	// Tool 8: List Due
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

	return server;
}

// --- Hono App with Auth Check ---

const app = new Hono().basePath("/echo-mcp");

app.all("/", async (c) => {
	if (c.req.method !== "POST") {
		return c.json({ error: "Method not allowed" }, 405);
	}

	const provided = c.req.header("x-echo-key") || new URL(c.req.url).searchParams.get("key");
	if (!provided || provided !== MCP_ACCESS_KEY) {
		return c.json({ error: "Invalid or missing access key" }, 401);
	}

	const server = createServer();
	const transport = new StreamableHTTPTransport();
	await server.connect(transport);
	return transport.handleRequest(c);
});

Deno.serve(app.fetch);

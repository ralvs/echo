import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
	const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "openai/text-embedding-3-small",
			input: text,
		}),
	});
	if (!r.ok) {
		const msg = await r.text().catch(() => "");
		throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
	}
	const d = await r.json();
	return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
	const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "openai/gpt-4o-mini",
			response_format: { type: "json_object" },
			messages: [
				{
					role: "system",
					content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
				},
				{ role: "user", content: text },
			],
		}),
	});
	const d = await r.json();
	try {
		return JSON.parse(d.choices[0].message.content);
	} catch {
		return { topics: ["uncategorized"], type: "observation" };
	}
}

// --- MCP Server Factory (stateless: new instance per request) ---
// Must create a fresh McpServer per request because server.connect()
// can only be called once per server instance. The module-level supabase client
// and helper functions are shared safely across requests.

function createServer(): McpServer {
	const server = new McpServer({
		name: "echo",
		version: "1.2.0",
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

				if (!data || data.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
					};
				}

				const results = data.map(
					(
						t: {
							id: string;
							content: string;
							metadata: Record<string, unknown>;
							similarity: number;
							created_at: string;
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
							text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
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
				"List recently captured thoughts with optional filters by type, topic, person, or time range.",
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
			},
		},
		async ({ limit, type, topic, person, days, status }) => {
			try {
				let q = supabase
					.from("thoughts")
					.select("id, content, metadata, created_at")
					.order("created_at", { ascending: false })
					.limit(limit);

				if (type) q = q.contains("metadata", { type });
				if (topic) q = q.contains("metadata", { topics: [topic] });
				if (person) q = q.contains("metadata", { people: [person] });
				if (status) q = q.contains("metadata", { status });
				if (days) {
					const since = new Date();
					since.setDate(since.getDate() - days);
					q = q.gte("created_at", since.toISOString());
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
						},
						i: number,
					) => {
						const m = t.metadata || {};
						const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
						const statusTag = m.status ? ` [${m.status}]` : "";
						return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})${statusTag}\n   ID: ${t.id}\n   ${t.content}`;
					},
				);

				return {
					content: [
						{
							type: "text" as const,
							text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
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
					.select("*", { count: "exact", head: true });

				const { data } = await supabase
					.from("thoughts")
					.select("metadata, created_at")
					.order("created_at", { ascending: false });

				const types: Record<string, number> = {};
				const topics: Record<string, number> = {};
				const people: Record<string, number> = {};

				for (const r of data || []) {
					const m = (r.metadata || {}) as Record<string, unknown>;
					if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
					if (Array.isArray(m.topics))
						for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
					if (Array.isArray(m.people))
						for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
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
					"",
					"Types:",
					...sort(types).map(([k, v]) => `  ${k}: ${v}`),
				];

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

	// Tool 4: Capture Thought
	// Accepts plain text, Markdown, or JSON as content. Optional type/topics
	// params let callers supply metadata hints that override auto-extraction. The "thought"
	// alias for "content" exists because some MCP clients use that parameter name.
	server.registerTool(
		"capture_thought",
		{
			title: "Capture Thought",
			description:
				"Save a new thought to Echo. Accepts plain text, Markdown, or JSON as content. Generates an embedding and extracts metadata automatically. You may optionally provide type and topics to override auto-extracted metadata. Use this when the user wants to save something — notes, insights, decisions, daily plans, structured logs, or migrated content from other systems.",
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
			},
		},
		async ({ content, thought, type, topics }) => {
			try {
				// Accept either "content" or "thought" parameter
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

				const [embedding, extracted] = await Promise.all([
					getEmbedding(text),
					extractMetadata(text),
				]);

				// Apply caller-supplied overrides to auto-extracted metadata
				const metadata = { ...extracted, source: "mcp" } as Record<string, unknown>;
				if (type) {
					metadata.type = type;
				}
				// Auto-set status for actionable thoughts
				const effectiveType = metadata.type as string;
				if (effectiveType === "task" || (Array.isArray(metadata.action_items) && metadata.action_items.length > 0)) {
					metadata.status = "open";
				}
				if (topics) {
					// Accept comma-separated string or array
					metadata.topics =
						typeof topics === "string"
							? topics
									.split(",")
									.map((t: string) => t.trim())
									.filter(Boolean)
							: topics;
				}

				const { data: inserted, error } = await supabase
					.from("thoughts")
					.insert({
						content: text,
						embedding,
						metadata,
					})
					.select("id")
					.single();

				if (error) {
					return {
						content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
						isError: true,
					};
				}

				let confirmation = `Captured as ${metadata.type || "thought"} (ID: ${inserted.id})`;
				if (Array.isArray(metadata.topics) && metadata.topics.length)
					confirmation += ` — ${(metadata.topics as string[]).join(", ")}`;
				if (Array.isArray(metadata.people) && metadata.people.length)
					confirmation += ` | People: ${(metadata.people as string[]).join(", ")}`;
				if (Array.isArray(metadata.action_items) && metadata.action_items.length)
					confirmation += ` | Actions: ${(metadata.action_items as string[]).join("; ")}`;

				return {
					content: [{ type: "text" as const, text: confirmation }],
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
	// Archives the current version to thought_versions before overwriting.
	// Generates fresh embedding + metadata for the new content. Version number increments.
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
			},
		},
		async ({ id, content, type, topics }) => {
			try {
				// 1. Fetch current thought
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

				// 2. Archive current version to thought_versions
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

				// 3. Generate new embedding + metadata in parallel
				const [embedding, extracted] = await Promise.all([
					getEmbedding(content),
					extractMetadata(content),
				]);

				// 4. Apply overrides
				const metadata = { ...extracted, source: "mcp" } as Record<string, unknown>;
				if (type) {
					metadata.type = type;
				}
				if (topics) {
					metadata.topics =
						typeof topics === "string"
							? topics
									.split(",")
									.map((t: string) => t.trim())
									.filter(Boolean)
							: topics;
				}

				// 5. Update the thought row
				const newVersion = (current.version || 1) + 1;
				const { error: updateErr } = await supabase
					.from("thoughts")
					.update({
						content,
						embedding,
						metadata,
						version: newVersion,
						updated_at: new Date().toISOString(),
					})
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
	// CASCADE on thought_versions FK means version history is auto-cleaned.
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
				// 1. Fetch thought to confirm existence and show what's being deleted
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

				// 2. Delete (CASCADE handles thought_versions cleanup)
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
	// Lightweight status toggle — no re-embedding needed since content doesn't change.
	server.registerTool(
		"resolve_thought",
		{
			title: "Resolve Thought",
			description:
				"Mark a thought as resolved (done) or reopen it. Use this to close out tasks, action items, or ideas that have been addressed. Works as a toggle — resolved thoughts can be reopened.",
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
					.select("id, content, metadata")
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

				const metadata = {
					...(thought.metadata as Record<string, unknown>),
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

				const m = thought.metadata as Record<string, unknown>;
				const preview =
					thought.content.length > 80
						? thought.content.substring(0, 80) + "..."
						: thought.content;

				return {
					content: [
						{
							type: "text" as const,
							text: `${status === "resolved" ? "Resolved" : "Reopened"} thought ${id} (${m.type || "unknown"}):\n"${preview}"`,
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

	return server;
}

// --- Hono App with Auth Check ---

const app = new Hono().basePath("/echo-mcp");

app.all("/", async (c) => {
	// MCP uses POST exclusively
	if (c.req.method !== "POST") {
		return c.json({ error: "Method not allowed" }, 405);
	}

	// Check access key
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

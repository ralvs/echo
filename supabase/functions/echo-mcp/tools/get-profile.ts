import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AI_GATEWAY_API_KEY, AI_GATEWAY_BASE, supabase } from "../config.ts";

export function registerGetProfile(server: McpServer) {
	server.registerTool(
		"get_profile",
		{
			title: "Get User Profile",
			description:
				"Synthesize a structured user profile from captured thoughts. Returns stable facts & preferences (static) and recent activity & open tasks (dynamic). Optionally focus on a specific domain/topic.",
			inputSchema: {
				focus: z
					.string()
					.optional()
					.describe(
						"Optional domain or topic to emphasize in the profile (e.g. 'cooking', 'work', 'health')",
					),
			},
		},
		async ({ focus }) => {
			try {
				// Static: facts + preferences (persistent knowledge)
				const { data: staticThoughts, error: staticErr } = await supabase
					.from("thoughts")
					.select("content, metadata")
					.or("metadata->>memory_type.eq.fact,metadata->>memory_type.eq.preference")
					.or("is_bundle.is.null,is_bundle.eq.false")
					.order("created_at", { ascending: false })
					.limit(100);

				if (staticErr) throw new Error(`Static query failed: ${staticErr.message}`);

				// Dynamic: recent episodic + open tasks
				const { data: dynamicThoughts, error: dynamicErr } = await supabase
					.from("thoughts")
					.select("content, metadata, due_at, priority")
					.or("metadata->>memory_type.eq.episodic,metadata->>status.eq.open")
					.or("is_bundle.is.null,is_bundle.eq.false")
					.order("created_at", { ascending: false })
					.limit(50);

				if (dynamicErr) throw new Error(`Dynamic query failed: ${dynamicErr.message}`);

				const staticBlock = (staticThoughts || [])
					.map((t) => {
						const m = t.metadata || {};
						let line = `- ${t.content}`;
						if (m.organization) line += ` [org: ${m.organization}]`;
						if (m.relationship && typeof m.relationship === "object") {
							const rels = Object.entries(m.relationship as Record<string, string>)
								.map(([name, role]) => `${name}=${role}`)
								.join(", ");
							if (rels) line += ` [relationships: ${rels}]`;
						}
						return line;
					})
					.join("\n");
				const dynamicBlock = (dynamicThoughts || [])
					.map((t) => {
						const m = t.metadata || {};
						const tags: string[] = [];
						if (m.status) tags.push(`[${m.status}]`);
						if (t.due_at) tags.push(`due:${t.due_at}`);
						if (t.priority && t.priority > 0) tags.push(`P${t.priority}`);
						if (m.project) tags.push(`project:${m.project}`);
						if (m.organization) tags.push(`org:${m.organization}`);
						if (m.sentiment) tags.push(`sentiment:${m.sentiment}`);
						if (m.relationship && typeof m.relationship === "object") {
							const rels = Object.entries(m.relationship as Record<string, string>)
								.map(([name, role]) => `${name}=${role}`)
								.join(", ");
							if (rels) tags.push(`rels:${rels}`);
						}
						const suffix = tags.length ? ` (${tags.join(", ")})` : "";
						return `- ${t.content}${suffix}`;
					})
					.join("\n");

				if (!staticBlock && !dynamicBlock) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Not enough captured thoughts to build a profile yet. Capture more facts, preferences, and daily notes first.",
							},
						],
					};
				}

				// Synthesize with LLM
				const r = await fetch(`${AI_GATEWAY_BASE}/chat/completions`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: "anthropic/claude-haiku-4-5",
						max_tokens: 2048,
						response_format: { type: "json_object" },
						messages: [
							{
								role: "system",
								content: `Synthesize a structured user profile from these captured thoughts.

STATIC FACTS & PREFERENCES (persistent):
${staticBlock || "(none yet)"}

RECENT EPISODES & ACTIVE TASKS (dynamic):
${dynamicBlock || "(none yet)"}

Return JSON with this structure:
{
  "static": {
    "facts": ["..."],
    "preferences": ["..."],
    "contact_graph": [{"name": "...", "role": "..."}],
    "organizations": ["..."]
  },
  "dynamic": {
    "active_projects": ["..."],
    "upcoming_events": ["..."],
    "recent_topics": ["..."],
    "open_tasks": ["..."],
    "sentiment_patterns": ["..."]
  },
  "summary": "A 2-3 sentence natural language summary of who this person is and what they're currently focused on."
}

Rules:
- Only include information explicitly present in the thoughts
- Keep each array entry concise (one sentence max)
- contact_graph: build from [relationships: ...] tags — each unique person with their role
- organizations: unique company/institution names from [org: ...] tags
- active_projects: use [project: ...] tags as primary signal, supplement with free-text inference
- sentiment_patterns: note any recurring emotional patterns (e.g. "consistently negative about X", "positive about Y")
- Empty arrays are fine if no relevant data exists
${focus ? `- Emphasize information related to: ${focus}` : ""}
Return ONLY valid JSON.`,
							},
							{
								role: "user",
								content: "Generate my profile.",
							},
						],
					}),
				});

				if (!r.ok) {
					const msg = await r.text().catch(() => "");
					throw new Error(`Profile synthesis failed: ${r.status} ${msg}`);
				}

				const d = await r.json();
				const raw = d.choices[0].message.content as string;
				const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
				const profile = JSON.parse(clean);

				// Format for display
				const parts: string[] = [];

				if (profile.summary) {
					parts.push(`## Summary\n${profile.summary}`);
				}

				const s = profile.static || {};
				if (s.facts?.length)
					parts.push(`## Facts\n${s.facts.map((f: string) => `• ${f}`).join("\n")}`);
				if (s.preferences?.length)
					parts.push(`## Preferences\n${s.preferences.map((p: string) => `• ${p}`).join("\n")}`);
				if (s.contact_graph?.length) {
					const contacts = (s.contact_graph as { name: string; role: string }[])
						.map((c) => `• ${c.name} — ${c.role}`)
						.join("\n");
					parts.push(`## People\n${contacts}`);
				}
				if (s.organizations?.length)
					parts.push(
						`## Organizations\n${s.organizations.map((o: string) => `• ${o}`).join("\n")}`,
					);

				const dy = profile.dynamic || {};
				if (dy.active_projects?.length)
					parts.push(
						`## Active Projects\n${dy.active_projects.map((p: string) => `• ${p}`).join("\n")}`,
					);
				if (dy.upcoming_events?.length)
					parts.push(
						`## Upcoming Events\n${dy.upcoming_events.map((e: string) => `• ${e}`).join("\n")}`,
					);
				if (dy.recent_topics?.length)
					parts.push(
						`## Recent Topics\n${dy.recent_topics.map((t: string) => `• ${t}`).join("\n")}`,
					);
				if (dy.open_tasks?.length)
					parts.push(`## Open Tasks\n${dy.open_tasks.map((t: string) => `• ${t}`).join("\n")}`);
				if (dy.sentiment_patterns?.length)
					parts.push(
						`## Sentiment Patterns\n${dy.sentiment_patterns.map((p: string) => `• ${p}`).join("\n")}`,
					);

				return {
					content: [
						{
							type: "text" as const,
							text: parts.join("\n\n") || "Profile is empty.",
						},
					],
				};
			} catch (err: unknown) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${(err as Error).message}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}

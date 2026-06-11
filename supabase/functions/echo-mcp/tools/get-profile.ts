import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UserProfile } from "../../_shared/ai.ts";
import { synthesizeProfile } from "../ai.ts";
import { supabase } from "../config.ts";

function formatProfile(profile: UserProfile): string {
	const parts: string[] = [];

	if (profile.summary) {
		parts.push(`## Summary\n${profile.summary}`);
	}

	const s = profile.static || {};
	if (s.facts?.length) parts.push(`## Facts\n${s.facts.map((f) => `• ${f}`).join("\n")}`);
	if (s.preferences?.length)
		parts.push(`## Preferences\n${s.preferences.map((p) => `• ${p}`).join("\n")}`);
	if (s.contact_graph?.length) {
		const contacts = s.contact_graph.map((c) => `• ${c.name} — ${c.role}`).join("\n");
		parts.push(`## People\n${contacts}`);
	}
	if (s.organizations?.length)
		parts.push(`## Organizations\n${s.organizations.map((o) => `• ${o}`).join("\n")}`);

	const dy = profile.dynamic || {};
	if (dy.active_projects?.length)
		parts.push(`## Active Projects\n${dy.active_projects.map((p) => `• ${p}`).join("\n")}`);
	if (dy.upcoming_events?.length)
		parts.push(`## Upcoming Events\n${dy.upcoming_events.map((e) => `• ${e}`).join("\n")}`);
	if (dy.recent_topics?.length)
		parts.push(`## Recent Topics\n${dy.recent_topics.map((t) => `• ${t}`).join("\n")}`);
	if (dy.open_tasks?.length)
		parts.push(`## Open Tasks\n${dy.open_tasks.map((t) => `• ${t}`).join("\n")}`);
	if (dy.sentiment_patterns?.length)
		parts.push(`## Sentiment Patterns\n${dy.sentiment_patterns.map((p) => `• ${p}`).join("\n")}`);

	return parts.join("\n\n") || "Profile is empty.";
}

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

				if (!staticThoughts?.length && !dynamicThoughts?.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Not enough captured thoughts to build a profile yet. Capture more facts, preferences, and daily notes first.",
							},
						],
					};
				}

				const profile = await synthesizeProfile(staticThoughts ?? [], dynamicThoughts ?? [], focus);

				return {
					content: [{ type: "text" as const, text: formatProfile(profile) }],
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

/**
 * Profile synthesis — the one place that defines what "the user's profile"
 * means: which thoughts feed it (static facts/preferences + dynamic recent
 * activity), how it's synthesized, and how it renders as markdown. The MCP
 * get_profile tool is a thin adapter over synthesizeUserProfile(), and any
 * future dashboard view crosses the same seam.
 */

import { synthesizeProfile, type UserProfile } from "./ai.ts";
import type { EchoDeps } from "./deps.ts";

const STATIC_LIMIT = 100;
const DYNAMIC_LIMIT = 50;

export type ProfileResult =
	| { kind: "empty" }
	| { kind: "profile"; profile: UserProfile; markdown: string };

export async function synthesizeUserProfile(
	deps: EchoDeps,
	focus?: string,
): Promise<ProfileResult> {
	const { db, ai } = deps;

	// Static: facts + preferences (persistent knowledge).
	const { data: staticThoughts, error: staticErr } = await db
		.from("thoughts")
		.select("content, metadata")
		.or("metadata->>memory_type.eq.fact,metadata->>memory_type.eq.preference")
		.or("is_bundle.is.null,is_bundle.eq.false")
		.order("created_at", { ascending: false })
		.limit(STATIC_LIMIT);

	if (staticErr) throw new Error(`Static query failed: ${staticErr.message}`);

	// Dynamic: recent episodic + open tasks (current context).
	const { data: dynamicThoughts, error: dynamicErr } = await db
		.from("thoughts")
		.select("content, metadata, due_at, priority")
		.or("metadata->>memory_type.eq.episodic,metadata->>status.eq.open")
		.or("is_bundle.is.null,is_bundle.eq.false")
		.order("created_at", { ascending: false })
		.limit(DYNAMIC_LIMIT);

	if (dynamicErr) throw new Error(`Dynamic query failed: ${dynamicErr.message}`);

	if (!staticThoughts?.length && !dynamicThoughts?.length) {
		return { kind: "empty" };
	}

	const profile = await synthesizeProfile(ai, staticThoughts ?? [], dynamicThoughts ?? [], focus);
	return { kind: "profile", profile, markdown: formatUserProfile(profile) };
}

export function formatUserProfile(profile: UserProfile): string {
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

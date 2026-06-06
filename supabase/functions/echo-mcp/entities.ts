/**
 * Entity graph projection. Entities are derived nodes pulled from a thought's
 * extracted metadata (people, project, organization, location, tools). Each
 * capture upserts the mentioned entities, links them to the thought as
 * evidence, and records undirected co-occurrence edges between every pair
 * mentioned together. Called fire-and-forget from the post-capture pipeline.
 */

import { supabase } from "./config.ts";

export type EntityType = "person" | "project" | "organization" | "tool" | "place";

export type EntityMention = { type: EntityType; name: string };

/**
 * Maps a thought's metadata to a deduped list of entity mentions.
 * Person names are expected to already be resolved to canonical names by the
 * extraction prompt (via the person entities surfaced by people.ts), so person
 * nodes stay consistent whether created here or through an explicit definition.
 */
export function extractEntityMentions(metadata: Record<string, unknown>): EntityMention[] {
	const mentions: EntityMention[] = [];
	const seen = new Set<string>();

	const add = (type: EntityType, raw: unknown) => {
		if (typeof raw !== "string") return;
		const name = raw.trim();
		if (!name) return;
		const key = `${type}:${name.toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		mentions.push({ type, name });
	};

	const people = metadata.people;
	if (Array.isArray(people)) for (const p of people) add("person", p);

	add("project", metadata.project);
	add("organization", metadata.organization);
	add("place", metadata.location);

	const tools = metadata.tools;
	if (Array.isArray(tools)) for (const t of tools) add("tool", t);

	return mentions;
}

/**
 * Upserts the given mentions, links them to the thought, and records
 * co-occurrence edges. Returns the affected entity ids so the caller can
 * decide which entity pages to refresh.
 */
export async function linkThoughtEntities(
	thoughtId: string,
	mentions: EntityMention[],
): Promise<string[]> {
	if (!mentions.length) return [];

	const ids: string[] = [];

	for (const m of mentions) {
		const { data, error } = await supabase.rpc("upsert_entity", {
			p_type: m.type,
			p_name: m.name,
		});
		if (error || !data) continue;
		const entityId = data as string;

		const { error: linkErr } = await supabase
			.from("thought_entities")
			.upsert(
				{ thought_id: thoughtId, entity_id: entityId, confidence: 1.0 },
				{ onConflict: "thought_id,entity_id" },
			);
		if (linkErr) continue;

		ids.push(entityId);
	}

	// Undirected co-occurrence edges between every pair mentioned together.
	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			await supabase.rpc("upsert_entity_edge", {
				p_source: ids[i],
				p_target: ids[j],
				p_type: "co_occurs_with",
			});
		}
	}

	return ids;
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildEmbeddingText } from "./ai.ts";
import type { EchoDeps } from "./deps.ts";
import type { PersonRecord } from "./types.ts";

/**
 * People are not a separate table — they are `entities` rows with type =
 * 'person'. This module is the curated-identity view over those rows: it
 * resolves relationship terms ("my mother-in-law") to canonical names during
 * extraction, and keeps the role on entities.metadata.role. The broader entity
 * graph (entities.ts) projects the same person nodes from thought metadata.
 */

const PERSON = "person";

type EntityPersonRow = {
	id: string;
	canonical_name: string;
	aliases: string[] | null;
	metadata: Record<string, unknown> | null;
};

/**
 * Returns the people the extractor should know about — those carrying a
 * resolution signal (a role or aliases). Bare person nodes auto-created from
 * mentions add nothing to alias resolution and are filtered out.
 */
export async function getKnownPeople(db: SupabaseClient): Promise<PersonRecord[]> {
	const { data } = await db
		.from("entities")
		.select("id, canonical_name, aliases, metadata")
		.eq("type", PERSON);

	return ((data ?? []) as EntityPersonRow[])
		.map((e) => ({
			id: e.id,
			canonical_name: e.canonical_name,
			role: (e.metadata?.role as string) ?? "contact",
			aliases: e.aliases ?? [],
		}))
		.filter((p) => p.aliases.length > 0 || p.role !== "contact");
}

/**
 * Upserts a person entity. Creates the node if new, otherwise registers the
 * role as an alias if not already present and records it on metadata.role.
 * Returns which aliases were newly registered so the caller can trigger
 * backfill for affected thoughts.
 */
export async function upsertPerson(
	db: SupabaseClient,
	canonical_name: string,
	role: string,
): Promise<{ newAliases: string[] }> {
	const roleAlias = role.toLowerCase().trim();

	const { data: existing } = await db
		.from("entities")
		.select("id, aliases, metadata")
		.eq("type", PERSON)
		.eq("canonical_name", canonical_name)
		.maybeSingle();

	if (existing) {
		const current = (existing.aliases as string[]) ?? [];
		if (current.includes(roleAlias)) return { newAliases: [] };

		const meta = (existing.metadata as Record<string, unknown>) ?? {};
		await db
			.from("entities")
			.update({
				aliases: [...current, roleAlias],
				metadata: { ...meta, role },
				updated_at: new Date().toISOString(),
			})
			.eq("id", existing.id);

		return { newAliases: [roleAlias] };
	}

	await db.from("entities").insert({
		type: PERSON,
		canonical_name,
		aliases: [roleAlias],
		metadata: { role },
	});
	return { newAliases: [roleAlias] };
}

/**
 * Finds all existing thoughts whose metadata.people contains the given alias,
 * replaces it with the canonical name, and re-embeds so the thought is
 * searchable by the canonical name going forward.
 */
export async function backfillPersonAlias(
	deps: EchoDeps,
	alias: string,
	canonicalName: string,
): Promise<void> {
	const { db, ai } = deps;
	const { data: thoughts } = await db
		.from("thoughts")
		.select("id, content, metadata, category")
		.contains("metadata", { people: [alias] });

	if (!thoughts?.length) return;

	for (const thought of thoughts) {
		const metadata = thought.metadata as Record<string, unknown>;
		const people = Array.isArray(metadata.people) ? (metadata.people as string[]) : [];
		const updatedPeople = people.map((p) => (p === alias ? canonicalName : p));
		const updatedMetadata = { ...metadata, people: updatedPeople };

		const embeddingText = buildEmbeddingText(
			thought.content as string,
			updatedMetadata,
			thought.category as string | null,
		);
		const embedding = await ai.embed(embeddingText);

		await db.from("thoughts").update({ metadata: updatedMetadata, embedding }).eq("id", thought.id);
	}
}

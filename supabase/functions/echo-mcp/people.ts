import { buildEmbeddingText, getEmbedding } from "./ai.ts";
import { supabase } from "./config.ts";

export type PersonRecord = {
	id: string;
	canonical_name: string;
	role: string;
	aliases: string[];
};

export type PersonDefinition = {
	canonical_name: string;
	role: string;
};

export async function getKnownPeople(): Promise<PersonRecord[]> {
	const { data } = await supabase.from("people").select("id, canonical_name, role, aliases");
	return (data ?? []) as PersonRecord[];
}

/**
 * Upserts a person definition. Creates the record if new, otherwise adds the role
 * as an alias if not already present. Returns which aliases were newly registered
 * so the caller can trigger backfill for affected thoughts.
 */
export async function upsertPerson(
	canonical_name: string,
	role: string,
): Promise<{ newAliases: string[] }> {
	const roleAlias = role.toLowerCase().trim();

	const { data: existing } = await supabase
		.from("people")
		.select("id, aliases")
		.eq("canonical_name", canonical_name)
		.maybeSingle();

	if (existing) {
		const current = existing.aliases as string[];
		if (current.includes(roleAlias)) return { newAliases: [] };

		await supabase
			.from("people")
			.update({ aliases: [...current, roleAlias], updated_at: new Date().toISOString() })
			.eq("id", existing.id);

		return { newAliases: [roleAlias] };
	}

	await supabase.from("people").insert({ canonical_name, role, aliases: [roleAlias] });
	return { newAliases: [roleAlias] };
}

/**
 * Finds all existing thoughts whose metadata.people contains the given alias,
 * replaces it with the canonical name, and re-embeds so the thought is
 * searchable by the canonical name going forward.
 */
export async function backfillPersonAlias(alias: string, canonicalName: string): Promise<void> {
	const { data: thoughts } = await supabase
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
		const embedding = await getEmbedding(embeddingText);

		await supabase
			.from("thoughts")
			.update({ metadata: updatedMetadata, embedding })
			.eq("id", thought.id);
	}
}

/**
 * Entity page adapter over the compiled-page lifecycle (page-lifecycle.ts).
 * Owns how entity sources are found — graph links plus co-occurrence edges —
 * and always recompiles in full (entity thought sets are small), deleting
 * stale pages when an entity drops below the threshold. The SQL tables
 * remain the single source of truth.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { compileEntityPage } from "./ai.ts";
import type { EchoDeps } from "./deps.ts";
import { PAGE_CREATION_THRESHOLD, PAGE_MAX_THOUGHTS, writeCompiledPage } from "./page-lifecycle.ts";
import { NON_BUNDLE_FILTER } from "./thoughts-store.ts";

const MAX_RELATED = 8; // cap related entities surfaced on a page

type RelatedEntity = { name: string; type: string; weight: number };

async function getRelatedEntities(db: SupabaseClient, entityId: string): Promise<RelatedEntity[]> {
	const { data: edges } = await db
		.from("entity_edges")
		.select("source_id, target_id, weight")
		.or(`source_id.eq.${entityId},target_id.eq.${entityId}`)
		.order("weight", { ascending: false })
		.limit(MAX_RELATED);

	if (!edges?.length) return [];

	const neighborIds = edges.map((e: { source_id: string; target_id: string }) =>
		e.source_id === entityId ? e.target_id : e.source_id,
	);
	const weightById = new Map<string, number>();
	for (const e of edges as { source_id: string; target_id: string; weight: number }[]) {
		const nid = e.source_id === entityId ? e.target_id : e.source_id;
		weightById.set(nid, e.weight);
	}

	const { data: neighbors } = await db
		.from("entities")
		.select("id, type, canonical_name")
		.in("id", neighborIds);

	return (neighbors ?? []).map((n: { id: string; type: string; canonical_name: string }) => ({
		name: n.canonical_name,
		type: n.type,
		weight: weightById.get(n.id) ?? 1,
	}));
}

/**
 * Full (re)compilation of a single entity's page from all its linked thoughts.
 * Creates the page if it crosses the threshold, updates it if it already
 * exists, and deletes a stale page if the entity dropped below the threshold.
 * Returns the resulting thought_count, or null if nothing was written.
 */
export async function recompileEntityPage(
	deps: EchoDeps,
	entityId: string,
): Promise<{
	title: string;
	entity_type: string;
	thought_count: number;
} | null> {
	const { db, ai } = deps;
	const { data: entity } = await db
		.from("entities")
		.select("id, type, canonical_name")
		.eq("id", entityId)
		.single();
	if (!entity) return null;

	const { data: links } = await db
		.from("thought_entities")
		.select("thought_id")
		.eq("entity_id", entityId);

	const thoughtIds = (links ?? []).map((l: { thought_id: string }) => l.thought_id);

	if (thoughtIds.length < PAGE_CREATION_THRESHOLD) {
		// Below threshold — remove any existing page so artifacts never go stale.
		await db.from("entity_pages").delete().eq("entity_id", entityId);
		return null;
	}

	const { data: thoughtRows } = await db
		.from("thoughts")
		.select("id, content, created_at")
		.in("id", thoughtIds)
		.or(NON_BUNDLE_FILTER)
		.order("created_at", { ascending: true })
		.limit(PAGE_MAX_THOUGHTS);

	const thoughts = (thoughtRows ?? []).map((t: { content: string; created_at: string }) => ({
		content: t.content,
		created_at: t.created_at,
	}));
	if (!thoughts.length) return null;

	const related = await getRelatedEntities(db, entityId);
	const compiledIds = (thoughtRows ?? []).map((t: { id: string }) => t.id);

	const { thought_count } = await writeCompiledPage(deps, {
		table: "entity_pages",
		conflictKey: "entity_id",
		key: { entity_id: entityId },
		title: entity.canonical_name,
		compile: () => compileEntityPage(ai, entity.canonical_name, entity.type, thoughts, related),
		thoughtIds: compiledIds,
		extra: { entity_type: entity.type, related },
	});

	return {
		title: entity.canonical_name,
		entity_type: entity.type,
		thought_count,
	};
}

/**
 * Called fire-and-forget after capture. Recompiles pages for the affected
 * entities that have crossed the mention threshold. Never throws.
 */
export async function updateEntityPagesForThought(
	deps: EchoDeps,
	entityIds: string[],
): Promise<void> {
	if (!entityIds.length) return;
	try {
		const { data: rows } = await deps.db
			.from("entities")
			.select("id, mention_count")
			.in("id", entityIds)
			.gte("mention_count", PAGE_CREATION_THRESHOLD);

		for (const row of (rows ?? []) as { id: string }[]) {
			await recompileEntityPage(deps, row.id).catch((e) =>
				console.error(`Entity page recompile failed for ${row.id}:`, e),
			);
		}
	} catch (err) {
		console.error("Entity page update failed:", err);
	}
}

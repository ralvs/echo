/**
 * Entity page lifecycle — the graph-backed analogue of topic-pages.ts.
 * Pages are generated artifacts: each refresh is a full recompile from the
 * entity's linked thoughts plus its strongest co-occurrence edges, so the
 * SQL tables remain the single source of truth.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { compileEntityPage } from "./ai.ts";
import type { EchoDeps } from "./deps.ts";

const CREATION_THRESHOLD = 3; // min linked thoughts before a page is built
const MAX_THOUGHTS = 50; // cap source thoughts fed into a single compile
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

	if (thoughtIds.length < CREATION_THRESHOLD) {
		// Below threshold — remove any existing page so artifacts never go stale.
		await db.from("entity_pages").delete().eq("entity_id", entityId);
		return null;
	}

	const { data: thoughtRows } = await db
		.from("thoughts")
		.select("id, content, created_at")
		.in("id", thoughtIds)
		.or("is_bundle.is.null,is_bundle.eq.false")
		.order("created_at", { ascending: true })
		.limit(MAX_THOUGHTS);

	const thoughts = (thoughtRows ?? []).map((t: { content: string; created_at: string }) => ({
		content: t.content,
		created_at: t.created_at,
	}));
	if (!thoughts.length) return null;

	const related = await getRelatedEntities(db, entityId);
	const summary = await compileEntityPage(
		ai,
		entity.canonical_name,
		entity.type,
		thoughts,
		related,
	);
	const embedding = await ai.embed(`${entity.canonical_name}\n\n${summary}`);
	const compiledIds = (thoughtRows ?? []).map((t: { id: string }) => t.id);

	await db.from("entity_pages").upsert(
		{
			entity_id: entityId,
			title: entity.canonical_name,
			entity_type: entity.type,
			summary,
			embedding,
			thought_ids: compiledIds,
			thought_count: compiledIds.length,
			related,
		},
		{ onConflict: "entity_id" },
	);

	return {
		title: entity.canonical_name,
		entity_type: entity.type,
		thought_count: compiledIds.length,
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
			.gte("mention_count", CREATION_THRESHOLD);

		for (const row of (rows ?? []) as { id: string }[]) {
			await recompileEntityPage(deps, row.id).catch((e) =>
				console.error(`Entity page recompile failed for ${row.id}:`, e),
			);
		}
	} catch (err) {
		console.error("Entity page update failed:", err);
	}
}

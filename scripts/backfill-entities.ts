#!/usr/bin/env bun
/**
 * Backfill the entity graph from existing thought metadata.
 *
 *   bun run scripts/backfill-entities.ts
 *
 * For every non-bundle thought, projects its metadata (people, project,
 * organization, location, tools) into the entities / thought_entities /
 * entity_edges tables via the upsert_entity and upsert_entity_edge RPCs.
 *
 * Cheap and API-free — no embeddings or LLM calls. Entity wiki pages are NOT
 * built here; they compile incrementally on the next capture that touches an
 * entity, or on demand via the refresh_entity_page MCP tool.
 *
 * Re-runnable: thoughts that already have entity links are skipped.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error("Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
	process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

type EntityType = "person" | "project" | "organization" | "tool" | "place";
type EntityMention = { type: EntityType; name: string };

function extractEntityMentions(metadata: Record<string, unknown>): EntityMention[] {
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

async function linkThought(thoughtId: string, mentions: EntityMention[]): Promise<number> {
	const ids: string[] = [];
	for (const m of mentions) {
		const { data, error } = await db.rpc("upsert_entity", { p_type: m.type, p_name: m.name });
		if (error || !data) continue;
		const entityId = data as string;
		const { error: linkErr } = await db
			.from("thought_entities")
			.upsert(
				{ thought_id: thoughtId, entity_id: entityId, confidence: 1.0 },
				{ onConflict: "thought_id,entity_id" },
			);
		if (!linkErr) ids.push(entityId);
	}

	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			await db.rpc("upsert_entity_edge", {
				p_source: ids[i],
				p_target: ids[j],
				p_type: "co_occurs_with",
			});
		}
	}

	return ids.length;
}

// Non-bundle thoughts only
const { data: thoughts, error: fetchErr } = await db
	.from("thoughts")
	.select("id, metadata")
	.or("is_bundle.is.null,is_bundle.eq.false")
	.order("created_at", { ascending: true });

if (fetchErr) {
	console.error("Failed to fetch thoughts:", fetchErr.message);
	process.exit(1);
}

// Skip thoughts already linked so the script is safe to re-run.
const { data: existingLinks } = await db.from("thought_entities").select("thought_id");
const alreadyLinked = new Set(
	(existingLinks ?? []).map((l: { thought_id: string }) => l.thought_id),
);

const todo = (thoughts as { id: string; metadata: Record<string, unknown> }[]).filter(
	(t) => !alreadyLinked.has(t.id),
);

console.log(
	`${thoughts.length} thoughts total, ${alreadyLinked.size} already linked → processing ${todo.length}`,
);

let processed = 0;
let totalLinks = 0;

for (const t of todo) {
	const mentions = extractEntityMentions(t.metadata ?? {});
	if (!mentions.length) {
		processed++;
		continue;
	}
	try {
		const linked = await linkThought(t.id, mentions);
		totalLinks += linked;
		processed++;
		if (linked > 0 && processed % 25 === 0) {
			console.log(`[${processed}/${todo.length}] … ${totalLinks} links so far`);
		}
	} catch (err) {
		console.error(`[${processed}/${todo.length}] ${t.id.slice(0, 8)} error:`, err);
	}
}

console.log(`\nDone. ${totalLinks} entity links written across ${processed} thoughts.`);
console.log("Entity pages will compile on next capture, or run refresh_entity_page on demand.");

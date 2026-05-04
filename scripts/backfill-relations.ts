#!/usr/bin/env bun
/**
 * Backfill thought_relations for all existing thoughts.
 *
 *   bun run scripts/backfill-relations.ts
 *
 * Reads .env.local automatically (Bun loads it by default).
 * Skips thoughts that already have outgoing relations so it's safe to re-run.
 */

import { createClient } from "@supabase/supabase-js";

const AI_GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1";
const AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY ?? "";
const SUPABASE_URL =
	process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_KEY || !AI_GATEWAY_API_KEY) {
	console.error(
		"Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AI_GATEWAY_API_KEY",
	);
	process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
	const r = await fetch(`${AI_GATEWAY_BASE}/embeddings`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
	});
	if (!r.ok) throw new Error(`Embedding failed: ${r.status} ${await r.text()}`);
	const d = await r.json();
	return d.data[0].embedding;
}

async function classifyRelation(
	newText: string,
	existingText: string,
): Promise<{ relation: string; confidence: number } | null> {
	try {
		const r = await fetch(`${AI_GATEWAY_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "anthropic/claude-haiku-4-5",
				max_tokens: 256,
				messages: [
					{
						role: "system",
						content: `Classify the relationship between two personal knowledge-base entries.
You MUST pick exactly one of these relation values: updates, extends, derives, related, unrelated.
- updates: new contradicts/replaces old
- extends: new adds detail to old without replacing
- derives: new is a logical consequence of old
- related: topically linked but independent
- unrelated: no meaningful link

Respond with ONLY a raw JSON object (no markdown): {"relation":"<value>","confidence":<0.0-1.0>}`,
					},
					{
						role: "user",
						content: `EXISTING THOUGHT:\n${existingText}\n\nNEW THOUGHT:\n${newText}`,
					},
				],
			}),
		});
		if (!r.ok) return null;
		const d = await r.json();
		const raw = d.choices[0].message.content as string;
		const jsonMatch = raw.match(/\{[^{}]*\}/);
		if (!jsonMatch) return null;
		const parsed = JSON.parse(jsonMatch[0]);
		if (!parsed.relation || typeof parsed.confidence !== "number") return null;
		if (parsed.confidence < 0.5) return null;
		const validTypes = ["updates", "extends", "derives", "related", "unrelated"];
		if (!validTypes.includes(parsed.relation)) return null;
		return parsed;
	} catch {
		return null;
	}
}

async function processThought(
	thoughtId: string,
	content: string,
	parentId: string | null,
): Promise<string[]> {
	const embedding = await getEmbedding(content);

	const { data: matches } = await db.rpc("hybrid_search", {
		query_text: content,
		query_embedding: embedding,
		match_threshold: 0.65,
		match_count: 5,
		alpha: 0.7,
		filter: {},
	});

	if (!matches || matches.length === 0) return [];

	const candidates = (matches as { id: string; content: string; parent_id?: string; is_bundle?: boolean }[]).filter(
		(m) => m.id !== thoughtId && !m.is_bundle && (!parentId || m.parent_id !== parentId),
	);

	const summaries: string[] = [];

	for (const candidate of candidates.slice(0, 3)) {
		const result = await classifyRelation(content, candidate.content);
		if (!result || result.relation === "unrelated") continue;

		await db.from("thought_relations").upsert(
			{
				source_id: thoughtId,
				target_id: candidate.id,
				relation_type: result.relation,
				confidence: result.confidence,
				is_latest: true,
			},
			{ onConflict: "source_id,target_id,relation_type" },
		);

		if (result.relation === "updates") {
			await db
				.from("thought_relations")
				.update({ is_latest: false })
				.eq("target_id", candidate.id)
				.eq("relation_type", "updates")
				.neq("source_id", thoughtId);
		}

		const preview = candidate.content.length > 60 ? `${candidate.content.slice(0, 60)}…` : candidate.content;
		summaries.push(`${result.relation} "${preview}" (${(result.confidence * 100).toFixed(0)}%)`);
	}

	return summaries;
}

// Fetch all non-bundle thoughts
const { data: thoughts, error: fetchErr } = await db
	.from("thoughts")
	.select("id, content, parent_id")
	.or("is_bundle.is.null,is_bundle.eq.false")
	.order("created_at", { ascending: true });

if (fetchErr) {
	console.error("Failed to fetch thoughts:", fetchErr.message);
	process.exit(1);
}

// Fetch IDs that already have outgoing relations so we can skip them
const { data: existing } = await db
	.from("thought_relations")
	.select("source_id")
	.eq("is_latest", true);

const alreadyLinked = new Set((existing ?? []).map((r: { source_id: string }) => r.source_id));
const todo = thoughts.filter((t: { id: string }) => !alreadyLinked.has(t.id));

console.log(
	`${thoughts.length} thoughts total, ${alreadyLinked.size} already linked → processing ${todo.length}`,
);

let processed = 0;
let totalEdges = 0;

for (const t of todo as { id: string; content: string; parent_id: string | null }[]) {
	try {
		const relations = await processThought(t.id, t.content, t.parent_id);
		processed++;
		totalEdges += relations.length;
		if (relations.length > 0) {
			console.log(`[${processed}/${todo.length}] ${t.id.slice(0, 8)} → ${relations.join(" | ")}`);
		} else if (processed % 20 === 0) {
			console.log(`[${processed}/${todo.length}] …`);
		}
	} catch (err) {
		console.error(`[${processed}/${todo.length}] ${t.id.slice(0, 8)} error:`, err);
	}
	await Bun.sleep(120);
}

console.log(`\nDone. ${totalEdges} edges written across ${processed} thoughts.`);

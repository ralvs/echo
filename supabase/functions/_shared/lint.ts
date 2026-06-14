/**
 * The lint workflow — the one place that defines Echo's knowledge-base health
 * checks: contradictions (LLM), orphaned episodic thoughts (SQL), stale
 * superseded facts (SQL), and near-duplicates (embedding RPC). Each check
 * returns structured findings; the MCP lint_thoughts tool is a formatting
 * adapter that selects checks and renders the report as text.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { detectContradictions } from "./ai.ts";
import type { EchoDeps } from "./deps.ts";
import { NON_BUNDLE_FILTER } from "./thoughts-store.ts";

export type Contradiction = { thought_a: string; thought_b: string; explanation: string };
export type ThoughtRef = { id: string; content: string; created_at: string };
export type DuplicatePair = {
	thought_a: string;
	thought_b: string;
	content_a: string;
	content_b: string;
	similarity: number;
};
export type DuplicateResult = { pairs: DuplicatePair[]; error?: string };

export type LintCheck = "contradictions" | "orphans" | "stale" | "duplicates";

export type LintReport = {
	contradictions?: Contradiction[];
	orphans?: ThoughtRef[];
	stale?: ThoughtRef[];
	duplicates?: DuplicateResult;
};

const ORPHAN_AGE_DAYS = 90;
/** Facts/preferences are clustered by topic for the LLM, so a wide net is fine. */
const FACT_SCAN_LIMIT = 200;

/** Conflicting fact/preference pairs, found by clustering on topic and asking
 * the LLM to spot contradictions within each cluster. */
export async function findContradictions(
	deps: EchoDeps,
	maxItems: number,
): Promise<Contradiction[]> {
	const { data: facts } = await deps.db
		.from("thoughts")
		.select("id, content, metadata")
		.in("metadata->>memory_type", ["fact", "preference"])
		.or(NON_BUNDLE_FILTER)
		.limit(FACT_SCAN_LIMIT);

	const factList = (facts ?? []).map(
		(f: { id: string; content: string; metadata: Record<string, unknown> }) => ({
			id: f.id,
			content: f.content,
			topics: Array.isArray(f.metadata?.topics) ? (f.metadata.topics as string[]) : [],
		}),
	);

	const contradictions = await detectContradictions(deps.ai, factList);
	return contradictions.slice(0, maxItems);
}

/** Episodic thoughts older than 90 days with no relations and no parent —
 * candidates for deletion or consolidation. */
export async function findOrphans(db: SupabaseClient, maxItems: number): Promise<ThoughtRef[]> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - ORPHAN_AGE_DAYS);

	const { data: orphans } = await db
		.from("thoughts")
		.select("id, content, created_at")
		.eq("metadata->>memory_type", "episodic")
		.lt("created_at", cutoff.toISOString())
		.is("parent_id", null)
		.or(NON_BUNDLE_FILTER)
		.limit(maxItems);

	const orphanIds = (orphans ?? []).map((t: { id: string }) => t.id);
	if (!orphanIds.length) return [];

	const quoted = orphanIds.map((id) => `"${id}"`).join(",");
	const { data: relatedIds } = await db
		.from("thought_relations")
		.select("source_id, target_id")
		.or(`source_id.in.(${quoted}),target_id.in.(${quoted})`);

	const connectedIds = new Set(
		(relatedIds ?? []).flatMap((r: { source_id: string; target_id: string }) => [
			r.source_id,
			r.target_id,
		]),
	);
	return (orphans ?? []).filter((t: { id: string }) => !connectedIds.has(t.id));
}

/** Facts/preferences whose every "updates" relation pointing at them is no
 * longer the latest — i.e. they have been fully superseded. */
export async function findStaleFacts(db: SupabaseClient, maxItems: number): Promise<ThoughtRef[]> {
	const { data: staleRows } = await db
		.from("thoughts")
		.select(
			`id, content, created_at, metadata,
			thought_relations!thought_relations_target_id_fkey(relation_type, is_latest)`,
		)
		.in("metadata->>memory_type", ["fact", "preference"])
		.or(NON_BUNDLE_FILTER)
		.limit(FACT_SCAN_LIMIT);

	return (staleRows ?? [])
		.filter((t: { thought_relations: { relation_type: string; is_latest: boolean }[] }) => {
			const updateRels = t.thought_relations.filter((r) => r.relation_type === "updates");
			return updateRels.length > 0 && updateRels.every((r) => r.is_latest === false);
		})
		.slice(0, maxItems)
		.map((t: { id: string; content: string; created_at: string }) => ({
			id: t.id,
			content: t.content,
			created_at: t.created_at,
		}));
}

/** Near-identical thought pairs (cosine ≥ 0.95) via the find_near_duplicates
 * RPC — candidates for merging. */
export async function findDuplicates(
	db: SupabaseClient,
	maxItems: number,
): Promise<DuplicateResult> {
	const { data: dupes, error } = await db.rpc("find_near_duplicates", {
		similarity_threshold: 0.95,
		max_results: maxItems,
	});
	if (error) return { pairs: [], error: error.message };
	return { pairs: (dupes ?? []) as DuplicatePair[] };
}

/** Runs the selected checks and returns their structured findings. */
export async function lintThoughts(
	deps: EchoDeps,
	options: { checks: LintCheck[]; maxItems?: number },
): Promise<LintReport> {
	const maxItems = options.maxItems ?? 10;
	const report: LintReport = {};

	if (options.checks.includes("contradictions"))
		report.contradictions = await findContradictions(deps, maxItems);
	if (options.checks.includes("orphans")) report.orphans = await findOrphans(deps.db, maxItems);
	if (options.checks.includes("stale")) report.stale = await findStaleFacts(deps.db, maxItems);
	if (options.checks.includes("duplicates"))
		report.duplicates = await findDuplicates(deps.db, maxItems);

	return report;
}

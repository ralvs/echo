/**
 * The search read path. One module owns everything between a query string
 * and enriched results: embedding, the hybrid_search RPC, bundle exclusion,
 * memory-decay scoring, parent-context injection for decomposed children,
 * and the topic/entity page preambles. The MCP tool and the REST route are
 * formatting adapters over this interface — neither knows the tuning knobs.
 */

import type { EchoDeps } from "./deps.ts";
import { applyDecay, type RawSearchResult } from "./search-assembly.ts";

export type { RawSearchResult };

export const SEARCH_TUNING = {
	/** Hybrid blend: 70% vector similarity, 30% full-text rank. */
	alpha: 0.7,
	/** Minimum hybrid score for an individual thought to match. */
	matchThreshold: 0.5,
	/** Minimum hybrid score for a compiled page to join the preamble. */
	pageThreshold: 0.5,
	/** Max topic pages and max entity pages per preamble (each). */
	pageCount: 2,
} as const;

export type PagePreamble = {
	kind: "topic" | "entity";
	title: string;
	/** Entity pages only — person, project, organization, tool, place. */
	entityType?: string;
	summary: string;
	updatedAt: string;
	thoughtCount: number;
};

/** A decay-adjusted search hit; decomposed children carry their parent
 * bundle's original text so the full capture is visible. */
export type ThoughtHit = RawSearchResult & { parentContent?: string };

export type SearchResponse = {
	results: ThoughtHit[];
	pages: PagePreamble[];
};

export type SearchOptions = {
	limit?: number;
	threshold?: number;
	/** Set false to skip the topic/entity page preamble fetches. */
	includePages?: boolean;
};

export async function searchThoughts(
	deps: EchoDeps,
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const { db, ai } = deps;
	const limit = options.limit ?? 10;
	const threshold = options.threshold ?? SEARCH_TUNING.matchThreshold;

	const embedding = await ai.embed(query);
	const { data, error } = await db.rpc("hybrid_search", {
		query_text: query,
		query_embedding: embedding,
		match_threshold: threshold,
		match_count: limit,
		alpha: SEARCH_TUNING.alpha,
		filter: {},
	});
	if (error) throw new Error(`hybrid_search failed: ${error.message}`);

	const raw = (data ?? []) as RawSearchResult[];
	const results: ThoughtHit[] = applyDecay(raw.filter((t) => !t.is_bundle));

	await injectParentContext(deps, results);

	const pages =
		results.length && (options.includePages ?? true)
			? await fetchPagePreambles(deps, query, embedding)
			: [];

	return { results, pages };
}

async function injectParentContext(deps: EchoDeps, results: ThoughtHit[]): Promise<void> {
	const parentIds = [
		...new Set(results.map((t) => t.parent_id).filter((p): p is string => Boolean(p))),
	];
	if (!parentIds.length) return;

	const { data: parents } = await deps.db
		.from("thoughts")
		.select("id, content")
		.in("id", parentIds);
	if (!parents) return;

	const parentMap = new Map(
		(parents as { id: string; content: string }[]).map((p) => [p.id, p.content]),
	);
	for (const r of results) {
		const content = r.parent_id ? parentMap.get(r.parent_id) : undefined;
		if (content) r.parentContent = content;
	}
}

/** Both page fetches are non-blocking: a preamble failure never costs the
 * caller its search results. */
async function fetchPagePreambles(
	deps: EchoDeps,
	query: string,
	embedding: number[],
): Promise<PagePreamble[]> {
	const pages: PagePreamble[] = [];

	try {
		const { data } = await deps.db.rpc("search_topic_pages", {
			query_text: query,
			query_embedding: embedding,
			match_threshold: SEARCH_TUNING.pageThreshold,
			match_count: SEARCH_TUNING.pageCount,
		});
		for (const p of (data ?? []) as {
			title: string;
			summary: string;
			updated_at: string;
			thought_count: number;
		}[]) {
			pages.push({
				kind: "topic",
				title: p.title,
				summary: p.summary,
				updatedAt: p.updated_at,
				thoughtCount: p.thought_count,
			});
		}
	} catch {
		// Non-blocking
	}

	try {
		const { data } = await deps.db.rpc("search_entity_pages", {
			query_text: query,
			query_embedding: embedding,
			match_threshold: SEARCH_TUNING.pageThreshold,
			match_count: SEARCH_TUNING.pageCount,
		});
		for (const p of (data ?? []) as {
			title: string;
			entity_type: string;
			summary: string;
			updated_at: string;
			thought_count: number;
		}[]) {
			pages.push({
				kind: "entity",
				title: p.title,
				entityType: p.entity_type,
				summary: p.summary,
				updatedAt: p.updated_at,
				thoughtCount: p.thought_count,
			});
		}
	} catch {
		// Non-blocking
	}

	return pages;
}

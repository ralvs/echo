/**
 * Retrieval eval harness — nDCG@10 + hit-rate@3 over a golden-query file,
 * scored through the real search read path (searchThoughts → hybrid_search
 * RPC → decay → parent injection). Nothing is mocked below the deps seam;
 * point it at the live corpus to measure retrieval quality before tuning.
 *
 * Query file format (JSON):
 *   { "queries": [ { "query": "...", "relevant": ["id-prefix-or-content-substring", ...] } ] }
 *
 * A hit is relevant (binary gain 1) when its `id` or `content` contains any
 * `relevant` entry (case-insensitive substring). Committed sample:
 * eval-queries.sample.json; the personal file eval-queries.echo.json is
 * gitignored because it quotes real corpus content.
 */

import { readFileSync } from "node:fs";
import type { EchoDeps } from "@shared/deps.ts";
import { searchThoughts } from "@shared/search.ts";

export type EvalQuery = {
	query: string;
	relevant: string[];
};

export type EvalFile = {
	queries: EvalQuery[];
};

export type EvalQueryResult = {
	query: string;
	ndcg10: number;
	hitRate3: number;
	/** How many of the top-10 hits were relevant — the raw recall signal. */
	relevantInTop10: number;
	returned: number;
};

export type EvalSummary = {
	results: EvalQueryResult[];
	meanNdcg10: number;
	meanHitRate3: number;
};

function round4(value: number): number {
	return Math.round(value * 1e4) / 1e4;
}

/** Binary relevance: id or content contains any relevant substring. */
export function isRelevant(hit: { id: string; content: string }, relevant: string[]): boolean {
	if (relevant.length === 0) return false;
	const idLower = hit.id.toLowerCase();
	const contentLower = hit.content.toLowerCase();
	for (const needle of relevant) {
		const n = needle.toLowerCase();
		if (idLower.includes(n) || contentLower.includes(n)) return true;
	}
	return false;
}

/**
 * Normalized Discounted Cumulative Gain at k (binary relevance).
 * `gains[i]` is the gain at rank i+1 (0 or 1). IDCG is the ideal reordering of
 * the retrieved gains (all 1s first), since with substring-matched relevance
 * the total relevant-document count in the corpus is unknowable — this measures
 * ranking quality of what was retrieved, and is 0 when nothing relevant surfaced.
 */
export function ndcgAtK(gains: number[], k: number): number {
	const slice = gains.slice(0, k);
	const idealCount = slice.reduce((sum, g) => sum + (g > 0 ? 1 : 0), 0);
	if (idealCount === 0) return 0;

	const dcg = slice.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
	let idcg = 0;
	for (let i = 0; i < idealCount; i++) {
		idcg += 1 / Math.log2(i + 2);
	}
	return idcg > 0 ? dcg / idcg : 0;
}

export function loadEvalFile(path: string): EvalFile {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as EvalFile;
	if (!Array.isArray(parsed.queries)) {
		throw new Error('eval file must have a "queries" array');
	}
	return parsed;
}

export async function evalQueries(deps: EchoDeps, file: string): Promise<EvalSummary> {
	const { queries } = loadEvalFile(file);
	const results: EvalQueryResult[] = [];

	for (const q of queries) {
		const { results: hits } = await searchThoughts(deps, q.query, {
			limit: 10,
			includePages: false,
		});
		const gains = hits.map((hit) => (isRelevant(hit, q.relevant) ? 1 : 0));
		results.push({
			query: q.query,
			ndcg10: round4(ndcgAtK(gains, 10)),
			hitRate3: gains.slice(0, 3).some((g) => g > 0) ? 1 : 0,
			relevantInTop10: gains.filter((g) => g > 0).length,
			returned: hits.length,
		});
	}

	const n = results.length;
	const meanNdcg10 = n > 0 ? round4(results.reduce((s, r) => s + r.ndcg10, 0) / n) : 0;
	const meanHitRate3 = n > 0 ? round4(results.reduce((s, r) => s + r.hitRate3, 0) / n) : 0;

	return { results, meanNdcg10, meanHitRate3 };
}

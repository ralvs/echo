/**
 * The compiled-page lifecycle shared by topic pages and entity pages. Both
 * page kinds are generated artifacts over the same invariants: a page exists
 * only once its sources cross the creation threshold, its embedding is always
 * computed from "title\n\nsummary" (the search_*_pages RPCs match against
 * this), and every write carries thought_ids plus a thought_count derived
 * from them. Topic and entity pages are the two adapters — they own how
 * sources are found (slug matching vs. graph links) and call here to
 * compile and persist.
 */

import type { EchoDeps } from "./deps.ts";

/** Minimum source thoughts before a page is created. */
export const PAGE_CREATION_THRESHOLD = 3;

/** Cap on source thoughts fed into a single compile. */
export const PAGE_MAX_THOUGHTS = 50;

export type PageWriteSpec = {
	table: "topic_pages" | "entity_pages";
	/** Column that identifies the page (e.g. "slug", "entity_id"). */
	conflictKey: string;
	/** Identifying column values, e.g. { slug } or { entity_id }. */
	key: Record<string, unknown>;
	title: string;
	/** Produces the markdown summary; receives nothing — close over inputs. */
	compile: () => Promise<string>;
	/** Source thought ids recorded on the page; thought_count derives from it. */
	thoughtIds: string[];
	/** Page-kind-specific columns (e.g. entity_type, related). */
	extra?: Record<string, unknown>;
};

/**
 * Compiles and persists one page: runs the compiler, embeds the summary
 * under its title, and upserts the row with source bookkeeping. Throws on
 * write errors so callers decide whether the context is fire-and-forget.
 */
export async function writeCompiledPage(
	deps: EchoDeps,
	spec: PageWriteSpec,
): Promise<{ summary: string; thought_count: number }> {
	const summary = await spec.compile();
	const embedding = await deps.ai.embed(`${spec.title}\n\n${summary}`);

	const { error } = await deps.db.from(spec.table).upsert(
		{
			...spec.key,
			title: spec.title,
			summary,
			embedding,
			thought_ids: spec.thoughtIds,
			thought_count: spec.thoughtIds.length,
			...spec.extra,
		},
		{ onConflict: spec.conflictKey },
	);
	if (error) throw new Error(`${spec.table} write failed: ${error.message}`);

	return { summary, thought_count: spec.thoughtIds.length };
}

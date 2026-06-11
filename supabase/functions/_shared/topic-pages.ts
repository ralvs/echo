/**
 * Topic page adapter over the compiled-page lifecycle (page-lifecycle.ts).
 * Owns how topic sources are found — slug + embedding matching via
 * identifyTopicPage — and whether a capture triggers a full compilation
 * (new page) or an incremental update (existing page).
 * Called non-blocking from the capture pipeline.
 */

import { compileTopicPage, identifyTopicPage } from "./ai.ts";
import type { EchoDeps } from "./deps.ts";
import { PAGE_CREATION_THRESHOLD, PAGE_MAX_THOUGHTS, writeCompiledPage } from "./page-lifecycle.ts";

type ExistingPage = {
	id: string;
	slug: string;
	title: string;
	embedding: number[];
};

type ThoughtRow = {
	id: string;
	content: string;
	created_at: string;
	metadata: Record<string, unknown>;
};

const toCompileInput = (rows: ThoughtRow[]) =>
	rows.map((t) => ({
		content: t.content,
		created_at: t.created_at,
		memory_type: t.metadata?.memory_type as string | undefined,
	}));

/**
 * Called after a thought is saved. Checks if any of the thought's topics
 * should create or update a topic page, then does so non-blocking.
 */
export async function updateTopicPagesForThought(
	deps: EchoDeps,
	thoughtId: string,
	thoughtContent: string,
	thoughtEmbedding: number[],
	thoughtCreatedAt: string,
	topics: string[],
	memoryType?: string,
): Promise<void> {
	if (!topics.length) return;
	const { db, ai } = deps;

	try {
		// Fetch all existing pages (slug + title + embedding) for matching
		const { data: existingPages } = await db
			.from("topic_pages")
			.select("id, slug, title, embedding");

		const pages: ExistingPage[] = existingPages ?? [];

		const match = identifyTopicPage(topics, pages, thoughtEmbedding, PAGE_CREATION_THRESHOLD);
		if (!match) return;

		if (match.isNew) {
			// Check if this topic has crossed the creation threshold
			const { data: countResult } = await db.rpc("count_thoughts_for_topic", {
				topic_slug: match.slug,
			});
			const count = (countResult as number) ?? 0;
			if (count < PAGE_CREATION_THRESHOLD) return;

			// Fetch all thoughts for this topic to do a full initial compilation
			const { data: topicThoughts } = await db
				.from("thoughts")
				.select("id, content, created_at, metadata")
				.contains("metadata->topics", JSON.stringify([match.slug]))
				.eq("is_bundle", false)
				.order("created_at", { ascending: true })
				.limit(PAGE_MAX_THOUGHTS);

			const rows = (topicThoughts ?? []) as ThoughtRow[];

			await writeCompiledPage(deps, {
				table: "topic_pages",
				conflictKey: "slug",
				key: { slug: match.slug },
				title: match.title,
				compile: () => compileTopicPage(ai, match.title, null, toCompileInput(rows)),
				thoughtIds: rows.map((t) => t.id),
			});
		} else {
			// Incremental update: existing page gets only the new thought
			const { data: page } = await db
				.from("topic_pages")
				.select("id, summary, thought_ids, thought_count")
				.eq("slug", match.slug)
				.single();

			if (!page) return;

			// Avoid reprocessing a thought already compiled into this page
			const alreadyIncluded = (page.thought_ids as string[]).includes(thoughtId);
			if (alreadyIncluded) return;

			await writeCompiledPage(deps, {
				table: "topic_pages",
				conflictKey: "slug",
				key: { slug: match.slug },
				title: match.title,
				compile: () =>
					compileTopicPage(ai, match.title, page.summary, [
						{ content: thoughtContent, created_at: thoughtCreatedAt, memory_type: memoryType },
					]),
				thoughtIds: [...(page.thought_ids as string[]), thoughtId],
			});
		}
	} catch (err) {
		// Non-blocking: log but never throw — capture flow must not fail
		console.error("Topic page update failed:", err);
	}
}

/**
 * Full recompilation of a topic page from all its source thoughts.
 * Used by the refresh_topic_page MCP tool.
 */
export async function recompileTopicPage(
	deps: EchoDeps,
	pageId: string,
): Promise<{
	slug: string;
	title: string;
	thought_count: number;
}> {
	const { db, ai } = deps;
	const { data: page, error } = await db
		.from("topic_pages")
		.select("id, slug, title, thought_ids")
		.eq("id", pageId)
		.single();

	if (error || !page) throw new Error(`Topic page not found: ${pageId}`);

	const { data: topicThoughts } = await db
		.from("thoughts")
		.select("id, content, created_at, metadata")
		.in("id", page.thought_ids as string[])
		.order("created_at", { ascending: true });

	const rows = (topicThoughts ?? []) as ThoughtRow[];

	const { thought_count } = await writeCompiledPage(deps, {
		table: "topic_pages",
		conflictKey: "slug",
		key: { slug: page.slug },
		title: page.title,
		compile: () => compileTopicPage(ai, page.title, null, toCompileInput(rows)),
		thoughtIds: rows.map((t) => t.id),
	});

	return { slug: page.slug, title: page.title, thought_count };
}

/**
 * Shared topic page lifecycle: create and incrementally update topic pages.
 * Called non-blocking after saveSingleThought in the capture flow.
 */

import { supabase } from "./config.ts";
import { getEmbedding, compileTopicPage, identifyTopicPage } from "./ai.ts";

const CREATION_THRESHOLD = 3; // min thoughts before creating a page

type ExistingPage = {
	id: string;
	slug: string;
	title: string;
	embedding: number[];
};

/**
 * Called after a thought is saved. Checks if any of the thought's topics
 * should create or update a topic page, then does so non-blocking.
 */
export async function updateTopicPagesForThought(
	thoughtId: string,
	thoughtContent: string,
	thoughtEmbedding: number[],
	thoughtCreatedAt: string,
	topics: string[],
	memoryType?: string,
): Promise<void> {
	if (!topics.length) return;

	try {
		// Fetch all existing pages (slug + title + embedding) for matching
		const { data: existingPages } = await supabase
			.from("topic_pages")
			.select("id, slug, title, embedding");

		const pages: ExistingPage[] = existingPages ?? [];

		const match = identifyTopicPage(topics, pages, thoughtEmbedding, CREATION_THRESHOLD);
		if (!match) return;

		if (match.isNew) {
			// Check if this topic has crossed the creation threshold
			const { data: countResult } = await supabase.rpc("count_thoughts_for_topic", {
				topic_slug: match.slug,
			});
			const count = (countResult as number) ?? 0;
			if (count < CREATION_THRESHOLD) return;

			// Fetch all thoughts for this topic to do a full initial compilation
			const { data: topicThoughts } = await supabase
				.from("thoughts")
				.select("id, content, created_at, metadata")
				.contains("metadata->topics", JSON.stringify([match.slug]))
				.eq("is_bundle", false)
				.order("created_at", { ascending: true })
				.limit(50);

			const thoughts = (topicThoughts ?? []).map(
				(t: { content: string; created_at: string; metadata: Record<string, unknown> }) => ({
					content: t.content,
					created_at: t.created_at,
					memory_type: t.metadata?.memory_type as string | undefined,
				}),
			);

			const summary = await compileTopicPage(match.title, null, thoughts);
			const embedding = await getEmbedding(`${match.title}\n\n${summary}`);
			const thoughtIds = (topicThoughts ?? []).map((t: { id: string }) => t.id);

			await supabase.from("topic_pages").insert({
				slug: match.slug,
				title: match.title,
				summary,
				embedding,
				thought_ids: thoughtIds,
				thought_count: thoughtIds.length,
			});
		} else {
			// Incremental update: existing page gets only the new thought
			const { data: page } = await supabase
				.from("topic_pages")
				.select("id, summary, thought_ids, thought_count")
				.eq("slug", match.slug)
				.single();

			if (!page) return;

			// Avoid reprocessing a thought already compiled into this page
			const alreadyIncluded = (page.thought_ids as string[]).includes(thoughtId);
			if (alreadyIncluded) return;

			const updatedSummary = await compileTopicPage(match.title, page.summary, [
				{ content: thoughtContent, created_at: thoughtCreatedAt, memory_type: memoryType },
			]);

			const updatedThoughtIds = [...(page.thought_ids as string[]), thoughtId];
			const updatedEmbedding = await getEmbedding(`${match.title}\n\n${updatedSummary}`);

			await supabase
				.from("topic_pages")
				.update({
					summary: updatedSummary,
					embedding: updatedEmbedding,
					thought_ids: updatedThoughtIds,
					thought_count: updatedThoughtIds.length,
				})
				.eq("id", page.id);
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
export async function recompileTopicPage(pageId: string): Promise<{
	slug: string;
	title: string;
	thought_count: number;
}> {
	const { data: page, error } = await supabase
		.from("topic_pages")
		.select("id, slug, title, thought_ids")
		.eq("id", pageId)
		.single();

	if (error || !page) throw new Error(`Topic page not found: ${pageId}`);

	const { data: topicThoughts } = await supabase
		.from("thoughts")
		.select("id, content, created_at, metadata")
		.in("id", page.thought_ids as string[])
		.order("created_at", { ascending: true });

	const thoughts = (topicThoughts ?? []).map(
		(t: { content: string; created_at: string; metadata: Record<string, unknown> }) => ({
			content: t.content,
			created_at: t.created_at,
			memory_type: t.metadata?.memory_type as string | undefined,
		}),
	);

	const summary = await compileTopicPage(page.title, null, thoughts);
	const embedding = await getEmbedding(`${page.title}\n\n${summary}`);

	await supabase
		.from("topic_pages")
		.update({ summary, embedding, thought_count: thoughts.length })
		.eq("id", pageId);

	return { slug: page.slug, title: page.title, thought_count: thoughts.length };
}

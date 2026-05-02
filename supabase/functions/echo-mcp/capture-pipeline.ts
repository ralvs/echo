import { classifyRelation, getEmbedding } from "./ai.ts";
import { supabase } from "./config.ts";
import { updateTopicPagesForThought } from "./topic-pages.ts";

export type PostCaptureSideEffects = {
	relations: string[];
	topicPageScheduled: boolean;
};

async function detectRelations(
	thoughtId: string,
	content: string,
	parentId?: string,
): Promise<string[]> {
	try {
		const embedding = await getEmbedding(content);
		const { data: matches } = await supabase.rpc("hybrid_search", {
			query_text: content,
			query_embedding: embedding,
			match_threshold: 0.8,
			match_count: 4,
			alpha: 0.7,
			filter: {},
		});

		if (!matches || matches.length === 0) return [];

		const candidates = matches.filter(
			(m: { id: string; parent_id?: string; is_bundle?: boolean }) =>
				m.id !== thoughtId && !m.is_bundle && (!parentId || m.parent_id !== parentId),
		);

		const summaries: string[] = [];

		for (const candidate of candidates.slice(0, 3)) {
			const result = await classifyRelation(content, candidate.content);
			if (!result || result.relation === "unrelated") continue;

			await supabase.from("thought_relations").upsert(
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
				await supabase
					.from("thought_relations")
					.update({ is_latest: false })
					.eq("target_id", candidate.id)
					.eq("relation_type", "updates")
					.neq("source_id", thoughtId);
			}

			const preview =
				candidate.content.length > 60
					? candidate.content.substring(0, 60) + "..."
					: candidate.content;
			summaries.push(`${result.relation} "${preview}" (${(result.confidence * 100).toFixed(0)}%)`);
		}

		return summaries;
	} catch (err) {
		console.error("Relation detection failed:", err);
		return [];
	}
}

/**
 * Runs the post-capture side-effect pipeline: relation detection (awaited)
 * and topic page update (fire-and-forget for response speed).
 * Returns a structured result so callers can surface what happened.
 */
export async function runPostCapturePipeline(
	thoughtId: string,
	content: string,
	embedding: number[],
	createdAt: string,
	topics: string[],
	memoryType?: string,
	parentId?: string,
): Promise<PostCaptureSideEffects> {
	const relations = await detectRelations(thoughtId, content, parentId);

	const topicPageScheduled = topics.length > 0;
	if (topicPageScheduled) {
		updateTopicPagesForThought(thoughtId, content, embedding, createdAt, topics, memoryType).catch(
			(e) => console.error("Topic page update error:", e),
		);
	}

	return { relations, topicPageScheduled };
}

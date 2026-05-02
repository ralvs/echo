import { buildEmbeddingText, decomposeWithLLM, extractMetadata, getEmbedding } from "./ai.ts";
import { DECOMPOSE_MIN_TOKENS, supabase } from "./config.ts";

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function hasMultipleTopics(text: string): boolean {
	const bullets = (text.match(/^[\t ]*[-*•]\s+/gm) || []).length;
	const headers = (text.match(/^#{1,3}\s+/gm) || []).length;
	const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 30);
	return bullets >= 3 || headers >= 2 || paragraphs.length >= 3;
}

export type AtomicThought = { content: string; type: string; topic: string };

/**
 * Single interface over the heuristic + LLM decomposition decision.
 * Returns atomic thoughts when decomposition is warranted, null otherwise.
 * Callers never need to reason about the two-layer fallback.
 */
export async function decompose(text: string, enabled: boolean): Promise<AtomicThought[] | null> {
	if (!enabled || estimateTokens(text) < DECOMPOSE_MIN_TOKENS || !hasMultipleTopics(text)) {
		return null;
	}
	return decomposeWithLLM(text);
}

export type SavedThought = {
	id: string;
	metadata: Record<string, unknown>;
	category: string | null;
	embedding: number[];
	created_at: string;
};

export async function saveSingleThought(
	text: string,
	overrides: Record<string, unknown>,
): Promise<SavedThought> {
	const extracted = await extractMetadata(text);

	// Destructure column fields — no manual delete needed
	const {
		category: extractedCategory,
		expires_at: extractedExpiresAt,
		event_at: extractedEventAt,
		due_at: extractedDueAt,
		recurrence: extractedRecurrence,
		priority: extractedPriority,
		...metadataFields
	} = extracted;

	const metadata: Record<string, unknown> = { ...metadataFields, source: "mcp" };
	if (overrides.type) metadata.type = overrides.type;
	if (overrides.topics) {
		metadata.topics =
			typeof overrides.topics === "string"
				? (overrides.topics as string)
						.split(",")
						.map((t: string) => t.trim())
						.filter(Boolean)
				: overrides.topics;
	}

	const effectiveType = metadata.type as string;
	const effectiveDueAt = overrides.due_at || extractedDueAt;
	if (
		effectiveType === "task" ||
		effectiveDueAt ||
		(Array.isArray(metadata.action_items) && metadata.action_items.length > 0)
	) {
		metadata.status = "open";
	}

	const effectiveCategory = (overrides.category as string | null) ?? extractedCategory;
	const embeddingText = buildEmbeddingText(text, metadata, effectiveCategory);
	const embedding = await getEmbedding(embeddingText);

	const row: Record<string, unknown> = {
		content: text,
		embedding,
		metadata,
	};

	// Real columns — caller overrides > extracted values
	if (overrides.due_at || extractedDueAt) row.due_at = overrides.due_at || extractedDueAt;
	if (overrides.recurrence || extractedRecurrence)
		row.recurrence = overrides.recurrence || extractedRecurrence;
	if (overrides.priority !== undefined && overrides.priority !== null) {
		row.priority = overrides.priority;
	} else if (extractedPriority && extractedPriority > 0) {
		row.priority = extractedPriority;
	}
	row.category = effectiveCategory;
	if (extractedExpiresAt) row.expires_at = extractedExpiresAt;
	if (extractedEventAt) row.event_at = extractedEventAt;
	if (overrides.is_bundle) row.is_bundle = true;
	if (overrides.parent_id) row.parent_id = overrides.parent_id;
	if (overrides.source_id) row.source_id = overrides.source_id;
	if (overrides.source_kind) row.source_kind = overrides.source_kind;

	const { data: inserted, error } = await supabase
		.from("thoughts")
		.insert(row)
		.select("id, created_at")
		.single();

	if (error) throw new Error(`Failed to capture: ${error.message}`);

	return {
		id: inserted.id,
		metadata,
		category: row.category as string | null,
		embedding,
		created_at: inserted.created_at as string,
	};
}

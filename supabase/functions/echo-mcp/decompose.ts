import { buildEmbeddingText, extractMetadata, getEmbedding } from "./ai.ts";
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

export function shouldDecompose(text: string, enabled: boolean): boolean {
	return enabled && estimateTokens(text) >= DECOMPOSE_MIN_TOKENS && hasMultipleTopics(text);
}

export async function saveSingleThought(
	text: string,
	overrides: Record<string, unknown>,
): Promise<{ id: string; metadata: Record<string, unknown>; category: string | null }> {
	// Extract metadata first so we can build an enriched embedding text
	const extracted = await extractMetadata(text);

	const extractedCategory = extracted.category as string | null;
	delete extracted.category;

	// expires_at and event_at are columns, not metadata — pull them out
	const extractedExpiresAt = (extracted.expires_at as string | null) ?? null;
	delete extracted.expires_at;
	const extractedEventAt = (extracted.event_at as string | null) ?? null;
	delete extracted.event_at;

	const metadata = { ...extracted, source: "mcp" } as Record<string, unknown>;
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
	if (
		effectiveType === "task" ||
		overrides.due_at ||
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

	if (overrides.due_at) row.due_at = overrides.due_at;
	if (extractedExpiresAt) row.expires_at = extractedExpiresAt;
	if (extractedEventAt) row.event_at = extractedEventAt;
	if (overrides.recurrence) row.recurrence = overrides.recurrence;
	if (overrides.priority !== undefined && overrides.priority !== null)
		row.priority = overrides.priority;
	row.category = effectiveCategory;
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

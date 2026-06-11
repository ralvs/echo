import { extractMetadata, getEmbedding } from "@/lib/ai";
import { createServiceClient } from "@/lib/supabase";
import type { RecurrenceRule, Thought, ThoughtMetadata } from "@/lib/types";

export type CaptureInput = {
	content: string;
	source_id?: string | null;
	source_kind?: string | null;
	due_at?: string | null;
	recurrence?: RecurrenceRule | null;
	priority?: number;
	category?: string | null;
	expires_at?: string | null;
	metadata?: Partial<ThoughtMetadata>;
};

export type CaptureOutput = { skipped: "duplicate"; id: string; source_id: string } | Thought;

const THOUGHT_COLUMNS =
	"id, content, metadata, version, due_at, recurrence, priority, category, source_id, source_kind, created_at, updated_at";

export async function captureThought(input: CaptureInput): Promise<CaptureOutput> {
	const supabase = createServiceClient();
	const { content, source_id, source_kind } = input;

	// Idempotency check — short-circuit if already captured from this source.
	if (source_id) {
		const { data: existing } = await supabase
			.from("thoughts")
			.select("id")
			.eq("source_id", source_id)
			.maybeSingle();
		if (existing) {
			return { skipped: "duplicate", id: existing.id, source_id };
		}
	}

	// AI processing in parallel: embedding + metadata extraction.
	const [embedding, extracted] = await Promise.all([
		getEmbedding(content),
		extractMetadata(content),
	]);

	// Separate real DB columns (and person_definitions, which is not stored
	// in metadata JSONB) from the JSONB metadata fields.
	const {
		category: extractedCategory,
		due_at: extractedDueAt,
		recurrence: extractedRecurrence,
		priority: extractedPriority,
		expires_at: extractedExpiresAt,
		event_at: extractedEventAt,
		person_definitions: _personDefinitions,
		...jsonbFields
	} = extracted;

	// Caller overrides take precedence over extracted values for metadata fields.
	const metadata: Record<string, unknown> = { ...jsonbFields, source: "echo" };
	if (input.metadata?.type) metadata.type = input.metadata.type;
	if (input.metadata?.topics) metadata.topics = input.metadata.topics;
	if (input.metadata?.memory_type) metadata.memory_type = input.metadata.memory_type;

	// Auto-set status for actionable thoughts.
	const effectiveDueAt = input.due_at || extractedDueAt;
	if (
		metadata.type === "task" ||
		effectiveDueAt ||
		(Array.isArray(metadata.action_items) && metadata.action_items.length > 0)
	) {
		metadata.status = "open";
	}

	const row: Record<string, unknown> = { content, embedding, metadata };

	// Real columns — caller overrides > extracted values.
	if (effectiveDueAt) row.due_at = effectiveDueAt;
	if (input.recurrence || extractedRecurrence)
		row.recurrence = input.recurrence || extractedRecurrence;
	if (input.priority !== undefined) {
		row.priority = input.priority;
	} else if (extractedPriority && extractedPriority > 0) {
		row.priority = extractedPriority;
	}
	row.category = input.category ?? extractedCategory ?? null;
	if (source_id) row.source_id = source_id;
	if (source_kind) row.source_kind = source_kind;
	if (input.expires_at) row.expires_at = input.expires_at;
	else if (extractedExpiresAt) row.expires_at = extractedExpiresAt;
	if (extractedEventAt) row.event_at = extractedEventAt;

	const { data, error } = await supabase
		.from("thoughts")
		.insert(row)
		.select(THOUGHT_COLUMNS)
		.single();

	if (error) {
		// Race between idempotency check and insert — treat as duplicate.
		if (error.code === "23505" && source_id) {
			const { data: existing } = await supabase
				.from("thoughts")
				.select("id")
				.eq("source_id", source_id)
				.maybeSingle();
			return { skipped: "duplicate", id: existing?.id ?? "", source_id };
		}
		throw new Error(error.message);
	}

	return data as Thought;
}

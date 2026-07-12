/**
 * The thought projection — the one place that turns extracted metadata plus
 * caller overrides into the shape a write needs: the JSONB `metadata` object,
 * the real-column values, and the enriched embedding text.
 *
 * Capture (insert) and update (patch) both project identically here; only how
 * they apply the result to the row differs (a full insert defaults absent
 * columns to null; a sparse patch leaves them untouched). Keeping the override
 * precedence, the status rule, and the enrichment in one pure function is why a
 * dashboard edit and an MCP capture can never disagree on what a value becomes.
 */

import { buildEmbeddingText, type ExtractedMetadata } from "./ai.ts";
import type { PersonDefinition, RecurrenceRule } from "./types.ts";

/** Resolved real-column values. `null` means "no signal" — the adapter decides
 * whether that becomes an explicit null (insert) or an absent key (patch). */
export type ThoughtColumns = {
	due_at: string | null;
	recurrence: RecurrenceRule | null;
	priority: number | null;
	category: string | null;
	expires_at: string | null;
	event_at: string | null;
};

export type ProjectedThought = {
	metadata: Record<string, unknown>;
	columns: ThoughtColumns;
	embeddingText: string;
	personDefinitions: PersonDefinition[];
};

/** Caller overrides shared by the capture and update inputs. */
export type ProjectionInput = {
	type?: string;
	topics?: string[] | string;
	memory_type?: string;
	due_at?: string | null;
	recurrence?: RecurrenceRule | null;
	priority?: number | null;
	category?: string | null;
	expires_at?: string | null;
};

export type ProjectionOptions = {
	/** Fields preserved from the existing thought (update path): status,
	 * resolved_at, last_completed, completion_count. Applied before the status
	 * rule so a content edit can't silently reopen a resolved task. */
	carry?: Record<string, unknown>;
	/** Shallow metadata patch merged last (update path's `input.metadata`). */
	metadataPatch?: Record<string, unknown>;
	/** Owner display name forwarded to buildEmbeddingText's anchor. */
	ownerName?: string | null;
};

function normalizeTopics(topics: string[] | string): string[] {
	return typeof topics === "string"
		? topics
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
		: topics;
}

export function projectThought(
	content: string,
	extracted: ExtractedMetadata,
	input: ProjectionInput,
	source: string,
	options: ProjectionOptions = {},
): ProjectedThought {
	// Column fields and person_definitions are not stored in metadata JSONB.
	const {
		category: extractedCategory,
		expires_at: extractedExpiresAt,
		event_at: extractedEventAt,
		due_at: extractedDueAt,
		recurrence: extractedRecurrence,
		priority: extractedPriority,
		person_definitions: personDefinitions,
		...metadataFields
	} = extracted;

	const metadata: Record<string, unknown> = { ...metadataFields, source };

	// Preserve operational metadata owned by resolve/recurrence (update path).
	if (options.carry) {
		for (const [key, value] of Object.entries(options.carry)) {
			if (value !== undefined) metadata[key] = value;
		}
	}

	if (input.type) metadata.type = input.type;
	if (input.topics) metadata.topics = normalizeTopics(input.topics);
	if (input.memory_type) metadata.memory_type = input.memory_type;
	if (options.metadataPatch) Object.assign(metadata, options.metadataPatch);

	// Column precedence: caller override wins, else extracted, else "no signal".
	const dueAt = input.due_at ?? extractedDueAt ?? null;
	const columns: ThoughtColumns = {
		due_at: dueAt,
		recurrence: input.recurrence ?? extractedRecurrence ?? null,
		priority:
			input.priority != null
				? input.priority
				: extractedPriority && extractedPriority > 0
					? extractedPriority
					: null,
		category: input.category ?? extractedCategory ?? null,
		expires_at: input.expires_at ?? extractedExpiresAt ?? null,
		event_at: extractedEventAt ?? null,
	};

	// Auto-open actionable thoughts — but never overwrite a carried status.
	if (
		metadata.status === undefined &&
		(metadata.type === "task" ||
			dueAt ||
			(Array.isArray(metadata.action_items) && metadata.action_items.length > 0))
	) {
		metadata.status = "open";
	}

	const embeddingText = buildEmbeddingText(content, metadata, columns.category, options.ownerName);

	return { metadata, columns, embeddingText, personDefinitions };
}

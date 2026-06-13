/**
 * The Update workflow — the one place that defines what "update a thought"
 * means: version archival, metadata re-extraction, re-embedding of the
 * enriched text, and the same compounding side effects as capture (relation
 * detection, topic pages, entity graph, person definitions).
 *
 * Both the Next.js PATCH route and the MCP update_thought tool are adapters
 * over updateThought(), so a dashboard edit and an MCP edit can never drift
 * — in particular, neither can change content without re-embedding.
 */

import { buildEmbeddingText, extractMetadata } from "./ai.ts";
import { runCompoundingPipeline, type SavedThought } from "./capture.ts";
import type { EchoDeps } from "./deps.ts";
import { getKnownPeople } from "./people.ts";
import { archiveThoughtVersion, getCurrentThought, writeThought } from "./thoughts-store.ts";
import type { PersonRecord, RecurrenceRule, Thought } from "./types.ts";

/**
 * Operational metadata is owned by the resolve/recurrence workflows, not by
 * extraction — a content edit must not silently reopen or un-complete a task.
 */
const CARRIED_METADATA_FIELDS = ["status", "resolved_at", "last_completed", "completion_count"];

export type UpdateInput = {
	/** New content. When present, metadata is re-extracted and the thought re-embedded. */
	content?: string;
	/** Shallow metadata patch, merged last (over extracted or current metadata). */
	metadata?: Record<string, unknown>;
	/** Override re-extracted type. */
	type?: string;
	/** Override re-extracted topics — array or comma-separated string. */
	topics?: string[] | string;
	due_at?: string;
	recurrence?: RecurrenceRule;
	priority?: number;
	category?: string;
};

export type UpdateOptions = {
	/** Tag stored on metadata.source ("echo" for the API, "mcp" for the tool). */
	source?: string;
	/** Scheduler for fire-and-forget side effects; see CaptureOptions.background. */
	background?: (work: Promise<unknown>) => void;
};

export type UpdateResult =
	| { kind: "not_found"; error: string }
	| { kind: "updated"; thought: Thought; previousVersion: number; relations: string[] };

export async function updateThought(
	deps: EchoDeps,
	id: string,
	input: UpdateInput,
	options: UpdateOptions = {},
): Promise<UpdateResult> {
	const { db, ai } = deps;
	const source = options.source ?? "echo";
	const background =
		options.background ??
		((work: Promise<unknown>) => {
			work.catch((e) => console.error("Update side effect failed:", e));
		});

	const current = await getCurrentThought(db, id);
	if (!current) return { kind: "not_found", error: "no matching ID" };

	await archiveThoughtVersion(db, current);

	const now = new Date().toISOString();
	const newVersion = (current.version || 1) + 1;
	const patch: Record<string, unknown> = { version: newVersion, updated_at: now };

	if (input.due_at !== undefined) patch.due_at = input.due_at;
	if (input.recurrence !== undefined) patch.recurrence = input.recurrence;
	if (input.priority !== undefined) patch.priority = input.priority;
	if (input.category !== undefined) patch.category = input.category;

	const contentChanged = input.content !== undefined && input.content !== current.content;

	// Metadata-only patch: no re-extraction, the embedding stays valid.
	if (!contentChanged) {
		patch.metadata = input.metadata
			? { ...(current.metadata ?? {}), ...input.metadata }
			: (current.metadata ?? {});
		const thought = await writeThought(db, id, patch);
		return { kind: "updated", thought, previousVersion: current.version, relations: [] };
	}

	const content = input.content as string;
	const knownPeople = await getKnownPeople(db).catch(() => [] as PersonRecord[]);
	const extracted = await extractMetadata(ai, content, knownPeople);

	// Destructure column fields and person_definitions — not stored in metadata JSONB.
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

	const currentMetadata = (current.metadata ?? {}) as Record<string, unknown>;
	const metadata: Record<string, unknown> = { ...metadataFields, source };
	for (const field of CARRIED_METADATA_FIELDS) {
		if (currentMetadata[field] !== undefined) metadata[field] = currentMetadata[field];
	}

	if (input.type) metadata.type = input.type;
	if (input.topics) {
		metadata.topics =
			typeof input.topics === "string"
				? input.topics
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
				: input.topics;
	}
	if (input.metadata) Object.assign(metadata, input.metadata);

	// Auto-set status for thoughts that became actionable (same rule as capture).
	const effectiveDueAt = input.due_at ?? extractedDueAt;
	if (
		metadata.status === undefined &&
		(metadata.type === "task" ||
			effectiveDueAt ||
			(Array.isArray(metadata.action_items) && metadata.action_items.length > 0))
	) {
		metadata.status = "open";
	}

	// Re-embed enriched text — the vector must always encode the new content.
	const effectiveCategory = input.category ?? extractedCategory;
	const embedding = await ai.embed(buildEmbeddingText(content, metadata, effectiveCategory));

	patch.content = content;
	patch.embedding = embedding;
	patch.metadata = metadata;

	// Caller overrides win; extracted values fill gaps; otherwise leave unchanged.
	if (input.due_at === undefined && extractedDueAt) patch.due_at = extractedDueAt;
	if (input.recurrence === undefined && extractedRecurrence) patch.recurrence = extractedRecurrence;
	if (input.priority === undefined && extractedPriority && extractedPriority > 0)
		patch.priority = extractedPriority;
	if (input.category === undefined && extractedCategory) patch.category = extractedCategory;
	if (extractedExpiresAt) patch.expires_at = extractedExpiresAt;
	if (extractedEventAt) patch.event_at = extractedEventAt;

	const thought = await writeThought(db, id, patch);

	const saved: SavedThought = { kind: "saved", thought, embedding, personDefinitions };
	const relations = await runCompoundingPipeline(
		deps,
		background,
		saved,
		current.parent_id ?? undefined,
	);

	return { kind: "updated", thought, previousVersion: current.version, relations };
}

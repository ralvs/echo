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

import { extractMetadata } from "./ai.ts";
import { runCompoundingPipeline, type SavedThought } from "./capture.ts";
import type { EchoDeps } from "./deps.ts";
import { getKnownPeople } from "./people.ts";
import { projectThought } from "./projection.ts";
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

	const contentChanged = input.content !== undefined && input.content !== current.content;

	// Metadata-only patch: no re-extraction, the embedding stays valid. Column
	// overrides are applied directly; nothing extracted fills the gaps.
	if (!contentChanged) {
		if (input.due_at !== undefined) patch.due_at = input.due_at;
		if (input.recurrence !== undefined) patch.recurrence = input.recurrence;
		if (input.priority !== undefined) patch.priority = input.priority;
		if (input.category !== undefined) patch.category = input.category;
		patch.metadata = input.metadata
			? { ...(current.metadata ?? {}), ...input.metadata }
			: (current.metadata ?? {});
		const thought = await writeThought(db, id, patch);
		return { kind: "updated", thought, previousVersion: current.version, relations: [] };
	}

	const content = input.content as string;
	const knownPeople = await getKnownPeople(db).catch(() => [] as PersonRecord[]);
	const extracted = await extractMetadata(ai, content, knownPeople);

	const currentMetadata = (current.metadata ?? {}) as Record<string, unknown>;
	const carry: Record<string, unknown> = {};
	for (const field of CARRIED_METADATA_FIELDS) {
		if (currentMetadata[field] !== undefined) carry[field] = currentMetadata[field];
	}

	const { metadata, columns, embeddingText, personDefinitions } = projectThought(
		content,
		extracted,
		input,
		source,
		{ carry, metadataPatch: input.metadata, ownerName: deps.ownerName },
	);

	// Re-embed enriched text — the vector must always encode the new content.
	const embedding = await ai.embed(embeddingText);

	patch.content = content;
	patch.embedding = embedding;
	patch.metadata = metadata;

	// Patch maps the resolved columns; an absent signal leaves the column untouched.
	if (columns.due_at != null) patch.due_at = columns.due_at;
	if (columns.recurrence != null) patch.recurrence = columns.recurrence;
	if (columns.priority != null) patch.priority = columns.priority;
	if (columns.category != null) patch.category = columns.category;
	if (columns.expires_at != null) patch.expires_at = columns.expires_at;
	if (columns.event_at != null) patch.event_at = columns.event_at;

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

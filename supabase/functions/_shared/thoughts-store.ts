/**
 * Named operations over the `thoughts` and `thought_versions` tables.
 * Workflows call these instead of assembling Supabase query chains, so
 * schema knowledge concentrates here and test fakes can stay per-operation
 * rather than re-implementing query-builder ergonomics.
 *
 * Grown incrementally: an operation moves here when a second workflow needs
 * it or when a fake has to mimic its chain. Not every query in _shared has
 * migrated yet.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Thought } from "./types.ts";

export const THOUGHT_COLUMNS =
	"id, content, metadata, version, due_at, expires_at, event_at, recurrence, priority, category, source_id, source_kind, created_at, updated_at";

/** The row shape every versioned write starts from. */
export type CurrentThought = {
	id: string;
	content: string;
	embedding: unknown;
	metadata: Record<string, unknown> | null;
	version: number;
	created_at: string;
	due_at: string | null;
	recurrence: Record<string, unknown> | null;
	parent_id: string | null;
};

/** Fetches the full current state of a thought, or null when it doesn't exist. */
export async function getCurrentThought(
	db: SupabaseClient,
	id: string,
): Promise<CurrentThought | null> {
	const { data, error } = await db
		.from("thoughts")
		.select("id, content, embedding, metadata, version, created_at, due_at, recurrence, parent_id")
		.eq("id", id)
		.single();
	if (error || !data) return null;
	return data as CurrentThought;
}

/**
 * Archives the current state to `thought_versions`. Every workflow that
 * rewrites a thought (update, resolve-and-advance) crosses this before
 * writing, so version history can never be skipped by one adapter.
 */
export async function archiveThoughtVersion(
	db: SupabaseClient,
	current: Pick<
		CurrentThought,
		"id" | "content" | "embedding" | "metadata" | "version" | "created_at"
	>,
	archivedAt: string = new Date().toISOString(),
): Promise<void> {
	const { error } = await db.from("thought_versions").insert({
		thought_id: current.id,
		version: current.version,
		content: current.content,
		embedding: current.embedding,
		metadata: current.metadata,
		created_at: current.created_at,
		archived_at: archivedAt,
	});
	if (error) throw new Error(`Failed to archive version: ${error.message}`);
}

/** Applies a patch to a thought and returns the updated row. */
export async function writeThought(
	db: SupabaseClient,
	id: string,
	patch: Record<string, unknown>,
	columns: string = THOUGHT_COLUMNS,
): Promise<Thought> {
	const { data, error } = await db
		.from("thoughts")
		.update(patch)
		.eq("id", id)
		.select(columns)
		.single();
	if (error) throw new Error(`Failed to update: ${error.message}`);
	return data as unknown as Thought;
}

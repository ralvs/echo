import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceRecurrence } from "./recurrence.ts";
import type { RecurrenceRule, ThoughtStatus } from "./types.ts";

const THOUGHT_COLUMNS =
	"id, content, metadata, version, due_at, recurrence, priority, category, created_at, updated_at";

export type ResolveResult =
	| { kind: "not_found"; error: string }
	| { kind: "toggled"; status: ThoughtStatus; thought: Record<string, unknown> }
	| { kind: "recurrence_ended"; thought: Record<string, unknown> }
	| {
			kind: "advanced";
			nextDue: Date;
			completionCount: number;
			thought: Record<string, unknown>;
	  };

/**
 * Resolve-and-advance: marks a thought resolved (or reopens it). For
 * recurring thoughts, resolving archives the current version and advances
 * the due date to the next occurrence — unless the recurrence has ended,
 * in which case the thought is resolved for good.
 *
 * The whole workflow lives here; the API route and the MCP tool are
 * adapters that only translate the result. Throws on DB write failures.
 */
export async function resolveThought(
	db: SupabaseClient,
	id: string,
	status: ThoughtStatus,
	now: Date = new Date(),
): Promise<ResolveResult> {
	const { data: current, error: fetchErr } = await db
		.from("thoughts")
		.select("id, content, embedding, metadata, version, created_at, due_at, recurrence")
		.eq("id", id)
		.single();

	if (fetchErr || !current) {
		return { kind: "not_found", error: fetchErr?.message ?? "no matching ID" };
	}

	const currentMetadata = (current.metadata ?? {}) as Record<string, unknown>;

	if (status === "resolved" && current.recurrence) {
		const rule = current.recurrence as RecurrenceRule;

		if (rule.end_at && new Date(rule.end_at) < now) {
			const metadata = {
				...currentMetadata,
				status: "resolved",
				resolved_at: now.toISOString(),
			};
			const thought = await updateThought(db, id, { metadata, updated_at: now.toISOString() });
			return { kind: "recurrence_ended", thought };
		}

		const { error: archiveErr } = await db.from("thought_versions").insert({
			thought_id: current.id,
			version: current.version,
			content: current.content,
			embedding: current.embedding,
			metadata: current.metadata,
			created_at: current.created_at,
			archived_at: now.toISOString(),
		});
		if (archiveErr) throw new Error(`Failed to archive version: ${archiveErr.message}`);

		const currentDue = current.due_at ? new Date(current.due_at) : null;
		const nextDue = advanceRecurrence(currentDue, rule, now);
		const completionCount = ((currentMetadata.completion_count as number) || 0) + 1;
		const metadata = {
			...currentMetadata,
			status: "open",
			resolved_at: null,
			last_completed: now.toISOString(),
			completion_count: completionCount,
		};

		const thought = await updateThought(db, id, {
			metadata,
			due_at: nextDue.toISOString(),
			version: (current.version || 1) + 1,
			updated_at: now.toISOString(),
		});
		return { kind: "advanced", nextDue, completionCount, thought };
	}

	const metadata = {
		...currentMetadata,
		status,
		...(status === "resolved" ? { resolved_at: now.toISOString() } : { resolved_at: null }),
	};
	const thought = await updateThought(db, id, { metadata, updated_at: now.toISOString() });
	return { kind: "toggled", status, thought };
}

async function updateThought(
	db: SupabaseClient,
	id: string,
	patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const { data, error } = await db
		.from("thoughts")
		.update(patch)
		.eq("id", id)
		.select(THOUGHT_COLUMNS)
		.single();
	if (error) throw new Error(error.message);
	return data as Record<string, unknown>;
}

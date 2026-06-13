import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceRecurrence } from "./recurrence.ts";
import { archiveThoughtVersion, getCurrentThought, writeThought } from "./thoughts-store.ts";
import type { RecurrenceRule, ThoughtStatus } from "./types.ts";

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
	const current = await getCurrentThought(db, id);
	if (!current) return { kind: "not_found", error: "no matching ID" };

	const currentMetadata = (current.metadata ?? {}) as Record<string, unknown>;

	if (status === "resolved" && current.recurrence) {
		const rule = current.recurrence as RecurrenceRule;

		if (rule.end_at && new Date(rule.end_at) < now) {
			const metadata = {
				...currentMetadata,
				status: "resolved",
				resolved_at: now.toISOString(),
			};
			const thought = await writeThought(db, id, { metadata, updated_at: now.toISOString() });
			return { kind: "recurrence_ended", thought };
		}

		await archiveThoughtVersion(db, current, now.toISOString());

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

		const thought = await writeThought(db, id, {
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
	const thought = await writeThought(db, id, { metadata, updated_at: now.toISOString() });
	return { kind: "toggled", status, thought };
}

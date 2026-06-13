/**
 * The thought-listing interface. One module owns the JSONB filter chain,
 * column filters, time windows, and sort orders that the MCP list tools and
 * the REST GET handler each used to rebuild by hand. Callers pass a filter
 * object and render the rows however they like; bundle parents are always
 * excluded. Adding a filter here adds it everywhere at once.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { NON_BUNDLE_FILTER } from "./thoughts-store.ts";

export const DEFAULT_LIST_COLUMNS =
	"id, content, metadata, created_at, event_at, due_at, priority, category, recurrence";

export type ThoughtListFilters = {
	limit?: number;
	type?: string;
	topic?: string;
	person?: string;
	status?: string;
	project?: string;
	organization?: string;
	sentiment?: string;
	category?: string;
	/** Minimum priority (inclusive). */
	minPriority?: number;
	/** true: only recurring thoughts; false: only non-recurring. */
	recurring?: boolean;
	/** Only thoughts captured in the last N days. */
	days?: number;
	/** Only open thoughts whose due_at is in the past. */
	overdue?: boolean;
	/** Only thoughts due between now and N days ahead. */
	dueWithinDays?: number;
	orderBy?: "created_at" | "due_at" | "priority";
};

export async function listThoughts<T = Record<string, unknown>>(
	db: SupabaseClient,
	filters: ThoughtListFilters = {},
	columns: string = DEFAULT_LIST_COLUMNS,
): Promise<T[]> {
	let q = db.from("thoughts").select(columns).or(NON_BUNDLE_FILTER);

	if (filters.limit) q = q.limit(filters.limit);

	// Sorting
	if (filters.orderBy === "due_at") {
		q = q.order("due_at", { ascending: true, nullsFirst: false });
	} else if (filters.orderBy === "priority") {
		q = q.order("priority", { ascending: false, nullsFirst: false });
	} else {
		q = q.order("created_at", { ascending: false });
	}

	// JSONB filters
	if (filters.type) q = q.contains("metadata", { type: filters.type });
	if (filters.topic) q = q.contains("metadata", { topics: [filters.topic] });
	if (filters.person) q = q.contains("metadata", { people: [filters.person] });
	if (filters.status) q = q.contains("metadata", { status: filters.status });
	if (filters.project) q = q.contains("metadata", { project: filters.project });
	if (filters.organization) q = q.contains("metadata", { organization: filters.organization });
	if (filters.sentiment) q = q.contains("metadata", { sentiment: filters.sentiment });

	// Column filters
	if (filters.category) q = q.eq("category", filters.category);
	if (filters.minPriority) q = q.gte("priority", filters.minPriority);
	if (filters.recurring === true) q = q.not("recurrence", "is", null);
	if (filters.recurring === false) q = q.is("recurrence", null);

	// Time windows
	if (filters.days) {
		const since = new Date();
		since.setDate(since.getDate() - filters.days);
		q = q.gte("created_at", since.toISOString());
	}

	const now = new Date().toISOString();
	if (filters.overdue) {
		q = q.lt("due_at", now).contains("metadata", { status: "open" });
	}
	if (filters.dueWithinDays) {
		const until = new Date();
		until.setDate(until.getDate() + filters.dueWithinDays);
		q = q.gte("due_at", now).lte("due_at", until.toISOString());
	}

	const { data, error } = await q;
	if (error) throw new Error(`thoughts query failed: ${error.message}`);
	return (data ?? []) as T[];
}

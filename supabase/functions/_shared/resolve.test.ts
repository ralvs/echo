import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { resolveThought } from "./resolve.ts";

type Row = Record<string, unknown>;

/**
 * Minimal fake of the Supabase query-builder surface that resolveThought
 * crosses: select-by-id, insert (version archive), and update-returning.
 */
function createFakeDb(thought: Row | null) {
	const inserts: { table: string; row: Row }[] = [];
	const updates: { table: string; patch: Row }[] = [];

	const db = {
		from(table: string) {
			return {
				select() {
					return {
						eq() {
							return {
								single: async () =>
									thought
										? { data: thought, error: null }
										: { data: null, error: { message: "not found" } },
							};
						},
					};
				},
				insert: async (row: Row) => {
					inserts.push({ table, row });
					return { error: null };
				},
				update(patch: Row) {
					updates.push({ table, patch });
					return {
						eq() {
							return {
								select() {
									return {
										single: async () => ({
											data: { id: thought?.id, ...patch },
											error: null,
										}),
									};
								},
							};
						},
					};
				},
			};
		},
	};

	return { db: db as unknown as SupabaseClient, inserts, updates };
}

const now = new Date("2026-01-15T12:00:00Z");

function baseThought(overrides: Row = {}): Row {
	return {
		id: "t1",
		content: "water the plants",
		embedding: [0.1, 0.2],
		metadata: { type: "task", status: "open" },
		version: 3,
		created_at: "2026-01-01T00:00:00Z",
		due_at: "2026-01-14T00:00:00Z",
		recurrence: null,
		...overrides,
	};
}

describe("resolveThought", () => {
	it("returns not_found when the thought does not exist", async () => {
		const { db } = createFakeDb(null);
		const result = await resolveThought(db, "missing", "resolved", now);
		expect(result.kind).toBe("not_found");
	});

	it("toggles a non-recurring thought to resolved with resolved_at set", async () => {
		const { db, updates, inserts } = createFakeDb(baseThought());
		const result = await resolveThought(db, "t1", "resolved", now);

		expect(result.kind).toBe("toggled");
		expect(inserts).toHaveLength(0); // no version archive for plain toggles
		const metadata = updates[0].patch.metadata as Row;
		expect(metadata.status).toBe("resolved");
		expect(metadata.resolved_at).toBe(now.toISOString());
	});

	it("reopens a resolved thought and clears resolved_at", async () => {
		const { db, updates } = createFakeDb(
			baseThought({ metadata: { status: "resolved", resolved_at: "2026-01-10T00:00:00Z" } }),
		);
		const result = await resolveThought(db, "t1", "open", now);

		expect(result.kind).toBe("toggled");
		const metadata = updates[0].patch.metadata as Row;
		expect(metadata.status).toBe("open");
		expect(metadata.resolved_at).toBeNull();
	});

	it("archives the version and advances the due date for recurring thoughts", async () => {
		const { db, updates, inserts } = createFakeDb(
			baseThought({ recurrence: { interval_days: 7 }, metadata: { completion_count: 2 } }),
		);
		const result = await resolveThought(db, "t1", "resolved", now);

		expect(result.kind).toBe("advanced");
		if (result.kind !== "advanced") return;

		// Version archived before the update
		expect(inserts).toHaveLength(1);
		expect(inserts[0].table).toBe("thought_versions");
		expect(inserts[0].row.version).toBe(3);
		expect(inserts[0].row.archived_at).toBe(now.toISOString());

		// Advanced 7 days past now (due was overdue, so base is now)
		expect(result.nextDue.getTime()).toBeGreaterThan(now.getTime());
		expect(result.completionCount).toBe(3);

		const patch = updates[0].patch;
		expect(patch.version).toBe(4);
		const metadata = patch.metadata as Row;
		expect(metadata.status).toBe("open"); // stays open for the next occurrence
		expect(metadata.completion_count).toBe(3);
		expect(metadata.last_completed).toBe(now.toISOString());
	});

	it("resolves for good when the recurrence has ended", async () => {
		const { db, updates, inserts } = createFakeDb(
			baseThought({ recurrence: { interval_days: 7, end_at: "2026-01-01T00:00:00Z" } }),
		);
		const result = await resolveThought(db, "t1", "resolved", now);

		expect(result.kind).toBe("recurrence_ended");
		expect(inserts).toHaveLength(0); // no archive — the chain is over
		const metadata = updates[0].patch.metadata as Row;
		expect(metadata.status).toBe("resolved");
		expect(metadata.resolved_at).toBe(now.toISOString());
	});

	it("does not treat reopening a recurring thought as a resolve-and-advance", async () => {
		const { db, inserts } = createFakeDb(
			baseThought({ recurrence: { interval_days: 7 }, metadata: { status: "resolved" } }),
		);
		const result = await resolveThought(db, "t1", "open", now);

		expect(result.kind).toBe("toggled");
		expect(inserts).toHaveLength(0);
	});
});

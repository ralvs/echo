import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Ai } from "./model.ts";
import { updateThought } from "./update.ts";

type Row = Record<string, unknown>;

const EXTRACTION = {
	people: ["Sarah"],
	action_items: [],
	dates_mentioned: [],
	topics: ["plumbing"],
	type: "observation",
	memory_type: "episodic",
	location: null,
	cost: null,
	url: null,
	rating: null,
	relationship: null,
	project: null,
	organization: null,
	tools: [],
	sentiment: null,
	category: "home",
	due_at: null,
	recurrence: null,
	priority: 0,
	expires_at: null,
	event_at: null,
	person_definitions: [],
};

const CURRENT: Row = {
	id: "t1",
	content: "old content",
	embedding: [0.9, 0.9, 0.9],
	metadata: { type: "task", topics: ["old-topic"], status: "open", source: "echo" },
	version: 2,
	created_at: "2026-01-01T00:00:00Z",
	due_at: null,
	recurrence: null,
	parent_id: null,
};

function fakeAi(extraction: Row = EXTRACTION) {
	const embedded: string[] = [];
	let generateCalls = 0;
	const ai: Ai = {
		async generate(): Promise<string> {
			generateCalls++;
			return JSON.stringify(extraction);
		},
		async embed(text: string): Promise<number[]> {
			embedded.push(text);
			return [0.1, 0.2, 0.3];
		},
	};
	return { ai, embedded, generateCalls: () => generateCalls };
}

/**
 * Fake of the Supabase surface the update workflow crosses: the current-row
 * fetch, the version archive, the patch write, and the known-people /
 * relation-detection reads from the compounding pipeline.
 */
function createFakeDb(current: Row | null = CURRENT) {
	const versions: Row[] = [];
	const patches: Row[] = [];

	// Awaitable + single/maybeSingle, matching supabase-js builder ergonomics.
	const result = (data: Row | null, list: Row[] = []) => ({
		single: async () =>
			data ? { data, error: null } : { data: null, error: { message: "not found" } },
		maybeSingle: async () => ({ data: list[0] ?? null, error: null }),
		// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
		then(resolve: (v: { data: Row[]; error: null }) => void) {
			resolve({ data: list, error: null });
		},
	});

	const db = {
		from(table: string) {
			return {
				select: () => ({
					eq: () => result(table === "thoughts" ? current : null),
					contains: () => result(null),
					in: () => result(null),
				}),
				insert(row: Row) {
					if (table === "thought_versions") versions.push(row);
					return {
						select: () => ({ single: async () => ({ data: row, error: null }) }),
						// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
						then(resolve: (v: { error: null }) => void) {
							resolve({ error: null });
						},
					};
				},
				update(patch: Row) {
					if (table === "thoughts") patches.push(patch);
					const updated = { ...(current ?? {}), ...patch };
					return {
						eq: () => ({
							neq: async () => ({ error: null }),
							select: () => ({ single: async () => ({ data: updated, error: null }) }),
							// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
							then(resolve: (v: { error: null }) => void) {
								resolve({ error: null });
							},
						}),
					};
				},
				upsert: async () => ({ error: null }),
				delete: () => ({ eq: async () => ({ error: null }) }),
			};
		},
		rpc: async (name: string) => {
			if (name === "hybrid_search") return { data: [], error: null };
			return { data: null, error: null };
		},
	};

	return { db: db as unknown as SupabaseClient, versions, patches };
}

function backgroundCollector() {
	const scheduled: Promise<unknown>[] = [];
	return {
		scheduled,
		background: (work: Promise<unknown>) => {
			scheduled.push(work.catch(() => {}));
		},
	};
}

describe("updateThought", () => {
	it("returns not_found without archiving when the thought doesn't exist", async () => {
		const { db, versions } = createFakeDb(null);
		const { ai } = fakeAi();

		const result = await updateThought({ db, ai }, "missing", { content: "new" });

		expect(result.kind).toBe("not_found");
		expect(versions).toHaveLength(0);
	});

	it("archives the previous version before writing", async () => {
		const { db, versions } = createFakeDb();
		const { ai } = fakeAi();

		const result = await updateThought({ db, ai }, "t1", { content: "new content" });

		expect(result.kind).toBe("updated");
		expect(versions).toHaveLength(1);
		expect(versions[0]).toMatchObject({ thought_id: "t1", version: 2, content: "old content" });
		if (result.kind !== "updated") return;
		expect(result.previousVersion).toBe(2);
	});

	it("re-extracts metadata and re-embeds enriched text on content change", async () => {
		const { db, patches } = createFakeDb();
		const { ai, embedded } = fakeAi();

		await updateThought(
			{ db, ai },
			"t1",
			{ content: "Fixed the sink with Sarah" },
			{
				source: "mcp",
			},
		);

		const patch = patches[0];
		expect(patch.content).toBe("Fixed the sink with Sarah");
		expect(patch.embedding).toEqual([0.1, 0.2, 0.3]);
		expect(patch.version).toBe(3);
		const metadata = patch.metadata as Row;
		expect(metadata.source).toBe("mcp");
		expect(metadata.topics).toEqual(["plumbing"]);
		// The stored embedding came from enriched text, not raw content.
		expect(embedded.some((t) => t.includes("Topics: plumbing"))).toBe(true);
	});

	it("carries operational metadata across re-extraction", async () => {
		const { db, patches } = createFakeDb({
			...CURRENT,
			metadata: {
				type: "task",
				status: "resolved",
				resolved_at: "2026-02-01",
				completion_count: 3,
			},
		});
		const { ai } = fakeAi();

		await updateThought({ db, ai }, "t1", { content: "revised task wording" });

		const metadata = patches[0].metadata as Row;
		expect(metadata.status).toBe("resolved");
		expect(metadata.resolved_at).toBe("2026-02-01");
		expect(metadata.completion_count).toBe(3);
	});

	it("applies a metadata-only patch without any model calls", async () => {
		const { db, versions, patches } = createFakeDb();
		const { ai, embedded, generateCalls } = fakeAi();

		const result = await updateThought({ db, ai }, "t1", { metadata: { pinned: true } });

		expect(result.kind).toBe("updated");
		expect(versions).toHaveLength(1); // still archived
		expect(generateCalls()).toBe(0);
		expect(embedded).toHaveLength(0);
		const metadata = patches[0].metadata as Row;
		expect(metadata.pinned).toBe(true);
		expect(metadata.type).toBe("task"); // merged over current
		expect(patches[0].content).toBeUndefined();
	});

	it("treats unchanged content as a metadata-only patch", async () => {
		const { db } = createFakeDb();
		const { ai, generateCalls } = fakeAi();

		await updateThought({ db, ai }, "t1", { content: "old content", priority: 4 });

		expect(generateCalls()).toBe(0);
	});

	it("lets caller overrides win over re-extracted values", async () => {
		const { db, patches } = createFakeDb();
		const { ai } = fakeAi();

		await updateThought({ db, ai }, "t1", {
			content: "new content",
			type: "idea",
			topics: "alpha, beta",
			category: "work",
			priority: 3,
		});

		const patch = patches[0];
		const metadata = patch.metadata as Row;
		expect(metadata.type).toBe("idea");
		expect(metadata.topics).toEqual(["alpha", "beta"]);
		expect(patch.category).toBe("work");
		expect(patch.priority).toBe(3);
	});

	it("schedules compounding side effects in the background", async () => {
		const { db } = createFakeDb();
		const { ai } = fakeAi();
		const { scheduled, background } = backgroundCollector();

		await updateThought({ db, ai }, "t1", { content: "note about plumbing" }, { background });

		// topic pages (topics exist) + entity graph (Sarah mention)
		expect(scheduled.length).toBeGreaterThanOrEqual(2);
		await Promise.all(scheduled);
	});
});

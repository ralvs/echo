import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { captureThought } from "./capture.ts";
import type { Ai, ModelRequest } from "./model.ts";

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

/**
 * Fake adapter at the model-call seam. Routes by prompt: extraction calls
 * return `extraction`, decomposition calls return `decomposition`.
 */
function fakeAi(extraction: Row = EXTRACTION, decomposition: Row[] | null = null): Ai {
	return {
		async generate(req: ModelRequest): Promise<string> {
			if (req.system.includes("decomposition engine")) {
				return JSON.stringify({ thoughts: decomposition ?? [] });
			}
			return JSON.stringify(extraction);
		},
		async embed(): Promise<number[]> {
			return [0.1, 0.2, 0.3];
		},
	};
}

/**
 * Fake of the Supabase surface the capture pipeline crosses: thoughts
 * insert/select, idempotency lookup, relation upserts, and the RPCs used
 * by relation detection and the compounding side effects.
 */
function createFakeDb(opts: { existingSourceIds?: string[] } = {}) {
	const thoughts: Row[] = [];
	const relationUpserts: Row[] = [];
	let idCounter = 0;

	// A select-chain terminator that is both awaitable (returns a list) and
	// extendable with maybeSingle, matching supabase-js builder ergonomics.
	const listResult = (data: Row[]) => ({
		maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
		// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
		then(resolve: (v: { data: Row[]; error: null }) => void) {
			resolve({ data, error: null });
		},
	});

	const db = {
		from(table: string) {
			return {
				select() {
					return {
						eq: (col: string, val: unknown) => {
							if (table === "thoughts" && col === "source_id") {
								const existing = opts.existingSourceIds?.includes(val as string)
									? [{ id: "existing-1" }]
									: thoughts.filter((t) => t.source_id === val);
								return listResult(existing as Row[]);
							}
							return listResult([]);
						},
						contains: () => listResult([]),
						in: () => listResult([]),
					};
				},
				insert(row: Row) {
					const saved = {
						...row,
						id: `t${++idCounter}`,
						version: 1,
						created_at: "2026-01-15T12:00:00Z",
						updated_at: "2026-01-15T12:00:00Z",
					};
					if (table === "thoughts") thoughts.push(saved);
					return {
						select: () => ({ single: async () => ({ data: saved, error: null }) }),
						// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
						then(resolve: (v: { error: null }) => void) {
							resolve({ error: null });
						},
					};
				},
				upsert: async (row: Row) => {
					if (table === "thought_relations") relationUpserts.push(row);
					return { error: null };
				},
				update: () => ({
					eq: () => ({
						neq: async () => ({ error: null }),
						// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
						then(resolve: (v: { error: null }) => void) {
							resolve({ error: null });
						},
					}),
				}),
				delete: () => ({ eq: async () => ({ error: null }) }),
			};
		},
		rpc: async (name: string) => {
			if (name === "hybrid_search") return { data: [], error: null };
			if (name === "count_thoughts_for_topic") return { data: 0, error: null };
			return { data: null, error: null }; // upsert_entity etc.
		},
	};

	return { db: db as unknown as SupabaseClient, thoughts, relationUpserts };
}

/** Collects background work so tests can await or count it. */
function backgroundCollector() {
	const scheduled: Promise<unknown>[] = [];
	return {
		scheduled,
		background: (work: Promise<unknown>) => {
			scheduled.push(work.catch(() => {}));
		},
	};
}

describe("captureThought", () => {
	it("returns duplicate without any model calls when source_id already exists", async () => {
		const { db } = createFakeDb({ existingSourceIds: ["sess:1"] });
		let aiCalled = false;
		const ai: Ai = {
			generate: async () => {
				aiCalled = true;
				return "{}";
			},
			embed: async () => {
				aiCalled = true;
				return [];
			},
		};

		const result = await captureThought({ db, ai }, { content: "x", source_id: "sess:1" });

		expect(result).toEqual({ kind: "duplicate", id: "existing-1", source_id: "sess:1" });
		expect(aiCalled).toBe(false);
	});

	it("saves a single thought with extracted metadata, source tag, and enriched embedding", async () => {
		const { db, thoughts } = createFakeDb();
		const embedded: string[] = [];
		const ai = fakeAi();
		const originalEmbed = ai.embed;
		ai.embed = async (text: string) => {
			embedded.push(text);
			return originalEmbed(text);
		};

		const result = await captureThought(
			{ db, ai },
			{ content: "Fixed the kitchen sink leak with Sarah" },
			{ source: "mcp" },
		);

		expect(result.kind).toBe("captured");
		expect(thoughts).toHaveLength(1);
		const metadata = thoughts[0].metadata as Row;
		expect(metadata.source).toBe("mcp");
		expect(metadata.topics).toEqual(["plumbing"]);
		expect(thoughts[0].category).toBe("home");
		// The stored embedding came from enriched text, not raw content
		expect(embedded[0]).toContain("Topics: plumbing");
		expect(embedded[0]).toContain("People: Sarah");
	});

	it("lets caller overrides win over extracted values", async () => {
		const { db, thoughts } = createFakeDb();

		await captureThought(
			{ db, ai: fakeAi() },
			{
				content: "note",
				type: "task",
				topics: "errands, weekend",
				category: "household",
				priority: 3,
			},
		);

		const metadata = thoughts[0].metadata as Row;
		expect(metadata.type).toBe("task");
		expect(metadata.topics).toEqual(["errands", "weekend"]);
		expect(metadata.status).toBe("open"); // tasks auto-open
		expect(thoughts[0].category).toBe("household");
		expect(thoughts[0].priority).toBe(3);
	});

	it("creates derives relations at confidence 1.0 for explicit source_ids", async () => {
		const { db, relationUpserts } = createFakeDb();

		await captureThought(
			{ db, ai: fakeAi() },
			{ content: "synthesized insight", source_ids: ["a", "b"] },
		);

		const derives = relationUpserts.filter((r) => r.relation_type === "derives");
		expect(derives).toHaveLength(2);
		expect(derives.map((r) => r.target_id)).toEqual(["a", "b"]);
		expect(derives.every((r) => r.confidence === 1.0)).toBe(true);
	});

	it("schedules compounding side effects in the background", async () => {
		const { db } = createFakeDb();
		const { scheduled, background } = backgroundCollector();

		await captureThought({ db, ai: fakeAi() }, { content: "note about plumbing" }, { background });

		// topic pages (topics exist) + entity graph (Sarah mention)
		expect(scheduled.length).toBeGreaterThanOrEqual(2);
		await Promise.all(scheduled);
	});

	it("decomposes long multi-topic input into a parent bundle and atomic children", async () => {
		const { db, thoughts } = createFakeDb();
		const paragraph = "This paragraph talks about one of several distinct subjects in detail. ";
		const content = [paragraph.repeat(5), paragraph.repeat(5), paragraph.repeat(5)].join("\n\n");
		const ai = fakeAi(EXTRACTION, [
			{ content: "First atomic thought", type: "observation", topic: "alpha" },
			{ content: "Second atomic thought", type: "task", topic: "beta" },
		]);

		const result = await captureThought({ db, ai }, { content });

		expect(result.kind).toBe("decomposed");
		if (result.kind !== "decomposed") return;
		expect(result.children.map((c) => c.topic)).toEqual(["alpha", "beta"]);

		const parent = thoughts[0];
		expect(parent.is_bundle).toBe(true);
		expect((parent.metadata as Row).type).toBe("log"); // bundles default to log

		const children = thoughts.slice(1);
		expect(children).toHaveLength(2);
		expect(children.every((c) => c.parent_id === parent.id)).toBe(true);
		expect((children[0].metadata as Row).topics).toEqual(["alpha"]);
	});

	it("does not decompose when decomposition is disabled", async () => {
		const { db, thoughts } = createFakeDb();
		const paragraph = "This paragraph talks about one of several distinct subjects in detail. ";
		const content = [paragraph.repeat(5), paragraph.repeat(5), paragraph.repeat(5)].join("\n\n");
		const ai = fakeAi(EXTRACTION, [
			{ content: "First", type: "observation", topic: "alpha" },
			{ content: "Second", type: "task", topic: "beta" },
		]);

		const result = await captureThought({ db, ai }, { content }, { decompose: false });

		expect(result.kind).toBe("captured");
		expect(thoughts).toHaveLength(1);
	});
});

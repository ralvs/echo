import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
	applyProposals,
	type DreamInput,
	type DreamProposal,
	type DreamReportMetadata,
	type DreamResult,
	dream,
	getDreamReport,
	lintFindingsToProposals,
	listRecentFingerprints,
	rejectProposals,
	writeDreamReport,
} from "./dream.ts";
import type { LintReport } from "./lint.ts";
import type { Ai, ModelRequest, ModelUsage } from "./model.ts";

type Row = Record<string, unknown>;

/**
 * Awaitable + single/maybeSingle terminator, matching supabase-js builder
 * ergonomics (see lint.test.ts / update.test.ts for the same pattern).
 */
function listResult(data: Row[]) {
	return {
		single: async () =>
			data.length
				? { data: data[0], error: null }
				: { data: null, error: { message: "not found" } },
		maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
		select: () => listResult(data),
		eq: () => listResult(data),
		in: () => listResult(data),
		gte: () => listResult(data),
		or: () => listResult(data),
		order: () => listResult(data),
		limit: () => listResult(data),
		// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
		then(resolve: (v: { data: Row[]; error: null }) => void) {
			resolve({ data, error: null });
		},
	};
}

/**
 * Real filtering (unlike listResult, which ignores every predicate) over an
 * in-memory row set — used for `thoughts` reads that must actually narrow by
 * id/source_id/source_kind/created_at: getCurrentThought, getReport,
 * getDreamReport, listRecentFingerprints all rely on the filter, not just
 * the shape, being correct.
 */
function thoughtsQuery(rows: Row[]) {
	return {
		eq(col: string, val: unknown) {
			return thoughtsQuery(rows.filter((r) => r[col] === val));
		},
		gte(col: string, val: unknown) {
			return thoughtsQuery(rows.filter((r) => (r[col] as string) >= (val as string)));
		},
		order(col: string, opts?: { ascending?: boolean }) {
			const sorted = [...rows].sort((a, b) => {
				const av = a[col] as string;
				const bv = b[col] as string;
				const cmp = av < bv ? -1 : av > bv ? 1 : 0;
				return opts?.ascending === false ? -cmp : cmp;
			});
			return thoughtsQuery(sorted);
		},
		limit(n: number) {
			return thoughtsQuery(rows.slice(0, n));
		},
		single: async () =>
			rows.length
				? { data: rows[0], error: null }
				: { data: null, error: { message: "not found" } },
		maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
		// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
		then(resolve: (v: { data: Row[]; error: null }) => void) {
			resolve({ data: rows, error: null });
		},
	};
}

type FakeDbOptions = {
	/** thoughts rows keyed by id — used for getCurrentThought/report lookups. */
	thoughtsById?: Record<string, Row>;
	/** search hits returned by hybrid_search (grounding + relation detection). */
	hybridSearchResults?: Row[];
	duplicates?: Row[];
	staleRows?: Row[];
	facts?: Row[];
	healthRows?: Row[];
	/** When true, any insert/update/delete against `thoughts` throws. */
	throwOnWrite?: boolean;
};

function createFakeDb(opts: FakeDbOptions = {}) {
	const inserted: Row[] = [];
	const updated: Row[] = [];
	const deleted: Row[] = [];
	const relationUpserts: Row[] = [];
	const thoughtsById: Record<string, Row> = { ...(opts.thoughtsById ?? {}) };
	let idCounter = 0;

	const db = {
		from(table: string) {
			return {
				select(cols?: string) {
					if (table === "thoughts" && cols?.includes("created_at") && !cols.includes("content")) {
						// Health probe.
						return listResult(opts.healthRows ?? []);
					}
					if (table === "thoughts" && cols?.includes("metadata")) {
						if (cols.includes("thought_relations")) return listResult(opts.staleRows ?? []);
						if (cols.includes("id")) return thoughtsQuery(Object.values(thoughtsById));
						return listResult(opts.facts ?? []);
					}
					return {
						...listResult(Object.values(thoughtsById)),
						eq: (col: string, val: unknown) => {
							if (table === "thoughts" && col === "id") {
								const row = thoughtsById[val as string];
								return listResult(row ? [row] : []);
							}
							if (table === "thoughts" && col === "source_id") {
								const row = Object.values(thoughtsById).find((t) => t.source_id === val);
								return listResult(row ? [row] : []);
							}
							return listResult([]);
						},
					};
				},
				insert(row: Row) {
					if (table === "thoughts" && opts.throwOnWrite) {
						throw new Error("unexpected write to thoughts");
					}
					const saved = {
						...row,
						id: `new-${++idCounter}`,
						version: 1,
						created_at: "2026-08-04T00:00:00Z",
						updated_at: "2026-08-04T00:00:00Z",
					};
					if (table === "thoughts") {
						inserted.push(saved);
						thoughtsById[saved.id] = saved;
					}
					return {
						select: () => ({ single: async () => ({ data: saved, error: null }) }),
						// biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are awaitable; the fake must be too
						then(resolve: (v: { error: null }) => void) {
							resolve({ error: null });
						},
					};
				},
				update(patch: Row) {
					if (table === "thoughts" && opts.throwOnWrite) {
						throw new Error("unexpected write to thoughts");
					}
					return {
						eq: (_col: string, val: unknown) => {
							if (table === "thoughts") {
								const current = thoughtsById[val as string] ?? {};
								const merged = { ...current, ...patch };
								thoughtsById[val as string] = merged;
								updated.push(merged);
							}
							return {
								neq: async () => ({ error: null }),
								select: () => ({
									single: async () => ({ data: thoughtsById[val as string], error: null }),
								}),
								// biome-ignore lint/suspicious/noThenProperty: awaitable, matches supabase-js
								then(resolve: (v: { error: null }) => void) {
									resolve({ error: null });
								},
							};
						},
					};
				},
				upsert: async (row: Row) => {
					if (table === "thought_relations") relationUpserts.push(row);
					return { error: null };
				},
				delete: () => {
					if (table === "thoughts" && opts.throwOnWrite) {
						throw new Error("unexpected delete against thoughts");
					}
					deleted.push({ table });
					return { eq: async () => ({ error: null }) };
				},
			};
		},
		rpc: async (name: string) => {
			if (name === "hybrid_search") return { data: opts.hybridSearchResults ?? [], error: null };
			if (name === "find_near_duplicates") return { data: opts.duplicates ?? [], error: null };
			if (name === "count_thoughts_for_topic") return { data: 0, error: null };
			return { data: null, error: null };
		},
	};

	return {
		db: db as unknown as SupabaseClient,
		inserted,
		updated,
		deleted,
		relationUpserts,
		thoughtsById,
	};
}

/** Routes by prompt: dream classification calls return `proposals`, every
 * other call (relation classification, metadata extraction) returns an
 * empty/neutral payload so capture side effects stay inert in these tests. */
function fakeAi(proposals: Row[] = []): Ai & { generateCalls: number } {
	const ai = {
		generateCalls: 0,
		async generate(req: ModelRequest): Promise<string> {
			ai.generateCalls++;
			if (req.system.includes("propose")) return JSON.stringify({ proposals });
			if (req.system.includes("Classify the relationship")) return "{}";
			return JSON.stringify({
				people: [],
				action_items: [],
				dates_mentioned: [],
				topics: [],
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
				category: null,
				due_at: null,
				recurrence: null,
				priority: 0,
				expires_at: null,
				event_at: null,
				person_definitions: [],
			});
		},
		async generateWithUsage(req: ModelRequest) {
			const text = await ai.generate(req);
			const usage: ModelUsage = { inputTokens: 10, outputTokens: 5 };
			return { text, usage };
		},
		async embed(): Promise<number[]> {
			return [0.1, 0.2, 0.3];
		},
	};
	return ai;
}

function makeTurn(overrides: Partial<Parameters<typeof baseTurn>[0]> = {}) {
	return baseTurn(overrides);
}

function baseTurn(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "sess-1",
		turnIndex: 1,
		// Contains a correction marker ("actually") so groundTurns lets it
		// through to the classifier even with no grounded search hits.
		userMessage: "Actually, I moved to Austin.",
		assistantMessage: "Got it, noted.",
		at: "2026-08-03T12:00:00Z",
		transcriptPath: "/tmp/sess-1.jsonl",
		...overrides,
	};
}

describe("dream()", () => {
	it("performs zero writes to thoughts", async () => {
		// throwOnWrite: true would also catch a write, but groundTurns and
		// proposeMemoryChanges both swallow exceptions internally — a write
		// buried inside either would be caught there and never propagate up to
		// fail this test. Assert directly on the fake's recorded calls instead
		// (and guard delete, which was previously unguarded).
		const { db, inserted, updated, deleted, relationUpserts } = createFakeDb({
			throwOnWrite: true,
		});
		const ai = fakeAi([
			{
				session_id: "sess-1",
				turn_index: 1,
				category: "new_fact",
				action: "create",
				target_ids: [],
				proposed_content: "Renan moved to Austin.",
				quote: "Just noting I moved to Austin.",
				confidence: 0.9,
				rationale: "New location fact.",
			},
		]);

		const input: DreamInput = {
			turns: [makeTurn()],
			window: { from: "2026-08-03", to: "2026-08-04" },
			now: new Date("2026-08-04T06:00:00Z"),
		};

		const result = await dream({ db, ai }, input);
		expect(result.proposals.length).toBeGreaterThan(0);
		expect(inserted).toHaveLength(0);
		expect(updated).toHaveLength(0);
		expect(deleted).toHaveLength(0);
		expect(relationUpserts).toHaveLength(0);
	});

	it("keeps 3+ distinct 'create' proposals distinct after dedupe (regression: all had target_ids: [], which collapsed the dedupe key to one survivor)", async () => {
		const { db } = createFakeDb();
		const raws = [1, 2, 3].map((i) => ({
			session_id: "sess-1",
			turn_index: i,
			category: "new_fact",
			action: "create",
			target_ids: [],
			proposed_content: `Distinct new fact number ${i}.`,
			quote: `Actually, distinct fact ${i}.`,
			confidence: 0.5 + i * 0.1,
			rationale: `New fact ${i}.`,
		}));
		const ai = fakeAi(raws);

		const input: DreamInput = {
			turns: [1, 2, 3].map((i) =>
				makeTurn({
					turnIndex: i,
					userMessage: `Actually, distinct fact ${i}.`,
					at: `2026-08-03T1${i}:00:00Z`,
				}),
			),
			window: { from: "2026-08-03", to: "2026-08-04" },
			now: new Date("2026-08-04T06:00:00Z"),
		};

		const result = await dream({ db, ai }, input);
		expect(result.proposals).toHaveLength(3);
		const contents = result.proposals.map((p) => p.proposed_content).sort();
		expect(contents).toEqual([
			"Distinct new fact number 1.",
			"Distinct new fact number 2.",
			"Distinct new fact number 3.",
		]);
	});

	it("numbers proposals 1..N and stably across two identical runs", async () => {
		const { db } = createFakeDb();
		const ai = fakeAi([
			{
				session_id: "sess-1",
				turn_index: 1,
				category: "new_fact",
				action: "create",
				target_ids: [],
				proposed_content: "Renan moved to Austin.",
				quote: "Just noting I moved to Austin.",
				confidence: 0.9,
				rationale: "New location fact.",
			},
			{
				session_id: "sess-1",
				turn_index: 2,
				category: "preference",
				action: "create",
				target_ids: [],
				proposed_content: "Renan prefers oat milk.",
				quote: "I've switched to oat milk.",
				confidence: 0.7,
				rationale: "New preference.",
			},
		]);

		const input: DreamInput = {
			turns: [
				makeTurn({ turnIndex: 1 }),
				makeTurn({
					turnIndex: 2,
					userMessage: "Actually, I've switched to oat milk.",
					at: "2026-08-03T13:00:00Z",
				}),
			],
			window: { from: "2026-08-03", to: "2026-08-04" },
			now: new Date("2026-08-04T06:00:00Z"),
		};

		const run1 = await dream({ db, ai }, input);
		const run2 = await dream({ db, ai }, input);

		expect(run1.proposals.map((p) => p.n)).toEqual([1, 2]);
		expect(run2.proposals.map((p) => p.n)).toEqual([1, 2]);
		expect(run1.proposals.map((p) => p.pid)).toEqual(run2.proposals.map((p) => p.pid));
	});

	it("truncates cleanly when onUsage returns stop", async () => {
		const { db } = createFakeDb();
		const ai = fakeAi([
			{
				session_id: "sess-1",
				turn_index: 1,
				category: "new_fact",
				action: "create",
				target_ids: [],
				proposed_content: "Renan moved to Austin.",
				quote: "Just noting I moved to Austin.",
				confidence: 0.9,
				rationale: "New location fact.",
			},
		]);

		const input: DreamInput = {
			turns: [makeTurn()],
			window: { from: "2026-08-03", to: "2026-08-04" },
			now: new Date("2026-08-04T06:00:00Z"),
			onUsage: () => "stop",
		};

		const result = await dream({ db, ai }, input);
		expect(result.truncated).toBe(true);
		expect(Array.isArray(result.proposals)).toBe(true);
	});

	it("drops a proposal whose fingerprint is suppressed (e.g. previously rejected)", async () => {
		const { db } = createFakeDb();
		const raw = {
			session_id: "sess-1",
			turn_index: 1,
			category: "new_fact",
			action: "create",
			target_ids: [],
			proposed_content: "Renan moved to Austin.",
			quote: "Just noting I moved to Austin.",
			confidence: 0.9,
			rationale: "New location fact.",
		};
		const ai = fakeAi([raw]);
		const input: DreamInput = {
			turns: [makeTurn()],
			window: { from: "2026-08-03", to: "2026-08-04" },
			now: new Date("2026-08-04T06:00:00Z"),
		};

		const first = await dream({ db, ai }, input);
		expect(first.proposals).toHaveLength(1);
		const fingerprint = first.proposals[0].fingerprint;

		const second = await dream(
			{ db, ai },
			{ ...input, suppressFingerprints: new Set([fingerprint]) },
		);
		expect(second.proposals).toHaveLength(0);
	});

	it("drops (never mis-attributes) a proposal whose echoed session_id/turn_index doesn't match any turn in the batch", async () => {
		const { db } = createFakeDb();
		// Model echoes a session_id that was never sent — must be dropped, not
		// stapled to batch[0]'s turn (which would inherit that turn's
		// transcript_path/at while keeping the model's wrong session id).
		const raw = {
			session_id: "sess-does-not-exist",
			turn_index: 99,
			category: "new_fact",
			action: "create",
			target_ids: [],
			proposed_content: "Renan moved to Austin.",
			quote: "Just noting I moved to Austin.",
			confidence: 0.9,
			rationale: "New location fact.",
		};
		const ai = fakeAi([raw]);
		const input: DreamInput = {
			turns: [makeTurn()],
			window: { from: "2026-08-03", to: "2026-08-04" },
			now: new Date("2026-08-04T06:00:00Z"),
		};

		const result = await dream({ db, ai }, input);
		expect(result.proposals).toHaveLength(0);
		expect(result.dropped).toBe(1);
	});

	it("malformed LLM JSON yields zero classifier proposals, never throws", async () => {
		const { db } = createFakeDb();
		const ai: Ai = {
			async generate(req: ModelRequest) {
				if (req.system.includes("propose")) return "not json {{{";
				return "{}";
			},
			async embed() {
				return [0.1];
			},
		};

		const input: DreamInput = {
			turns: [makeTurn()],
			window: { from: "2026-08-03", to: "2026-08-04" },
			now: new Date("2026-08-04T06:00:00Z"),
		};

		const result = await dream({ db, ai }, input);
		expect(result.proposals).toEqual([]);
	});
});

describe("lintFindingsToProposals", () => {
	it("maps duplicates to merge with both target ids", () => {
		const report: LintReport = {
			duplicates: {
				pairs: [
					{
						thought_a: "a1",
						thought_b: "a2",
						content_a: "loves pizza",
						content_b: "loves pizza",
						similarity: 0.97,
					},
				],
			},
		};
		const proposals = lintFindingsToProposals(report);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({ action: "merge", category: "duplicate" });
		expect(proposals[0].target_ids).toEqual(["a1", "a2"]);
		// proposed_content must be the resulting memory text, not a directive
		// sentence — the directive lives in rationale instead.
		expect(proposals[0].proposed_content).toBe("loves pizza");
		expect(proposals[0].proposed_content).not.toMatch(/^Merge near-duplicate/);
		expect(proposals[0].rationale).toMatch(/^Merge near-duplicate/);
	});

	it("maps duplicates to merge, keeping the longer/more complete side as proposed_content", () => {
		const report: LintReport = {
			duplicates: {
				pairs: [
					{
						thought_a: "a1",
						thought_b: "a2",
						content_a: "pizza",
						content_b: "loves pepperoni pizza from Luigi's",
						similarity: 0.9,
					},
				],
			},
		};
		const proposals = lintFindingsToProposals(report);
		expect(proposals[0].proposed_content).toBe("loves pepperoni pizza from Luigi's");
	});

	it("maps stale facts to expire with the single target id, proposed_content for display only", () => {
		const report: LintReport = {
			stale: [{ id: "s1", content: "old address", created_at: "2026-01-01T00:00:00Z" }],
		};
		const proposals = lintFindingsToProposals(report);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({ action: "expire", category: "stale" });
		expect(proposals[0].target_ids).toEqual(["s1"]);
		// Display-only: the target's existing content, never a directive.
		expect(proposals[0].proposed_content).toBe("old address");
		expect(proposals[0].rationale).toMatch(/^Expire stale fact/);
	});

	it("maps contradictions to supersede with both target ids and empty proposed_content", () => {
		const report: LintReport = {
			contradictions: [{ thought_a: "c1", thought_b: "c2", explanation: "two addresses" }],
		};
		const proposals = lintFindingsToProposals(report);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({ action: "supersede", category: "correction" });
		expect(proposals[0].target_ids).toEqual(["c1", "c2"]);
		// findContradictions only yields an explanation, never a resolved fact —
		// nothing safe to capture, so applyProposals must refuse this one.
		expect(proposals[0].proposed_content).toBe("");
		expect(proposals[0].rationale).toBe("Resolve contradiction: two addresses");
	});
});

describe("applyProposals", () => {
	function makeReport(proposals: DreamProposal[]) {
		const dreamMeta: DreamReportMetadata = {
			run_at: "2026-08-04T00:00:00Z",
			window: { from: "2026-08-03", to: "2026-08-04" },
			scanned: { turns: 1, sessions: 1 },
			cost_usd: 0,
			auto_applied: [],
			proposals,
			health: { newest_capture_at: null, capture_pipeline_stale: false },
		};
		return {
			id: "report-1",
			content: "Echo dream report 2026-08-04",
			embedding: [0.1, 0.2, 0.3],
			metadata: { dream: dreamMeta },
			version: 1,
			created_at: "2026-08-04T00:00:00Z",
			due_at: null,
			recurrence: null,
			parent_id: null,
		};
	}

	function proposal(n: number, overrides: Partial<DreamProposal> = {}): DreamProposal {
		return {
			n,
			pid: `dream:2026-08-04#${n}`,
			category: "new_fact",
			action: "create",
			target_ids: [],
			proposed_content: `Proposal ${n} content`,
			evidence: {
				quote: "quote",
				session_id: "sess-1",
				turn_index: n,
				transcript_path: "/tmp/sess-1.jsonl",
				at: "2026-08-03T12:00:00Z",
			},
			confidence: 0.8,
			rationale: "because",
			fingerprint: `fp-${n}`,
			status: "pending",
			...overrides,
		};
	}

	it("mutates only the requested proposal numbers, leaves others pending", async () => {
		const report = makeReport([proposal(1), proposal(2), proposal(3)]);
		const { db, thoughtsById, updated } = createFakeDb({
			thoughtsById: { "report-1": report },
		});
		const ai = fakeAi();

		const outcomes = await applyProposals({ db, ai }, "report-1", [1, 3]);

		expect(outcomes.map((o) => o.status)).toEqual(["applied", "applied"]);

		const finalMeta = thoughtsById["report-1"].metadata as { dream: DreamReportMetadata };
		const byN = new Map(finalMeta.dream.proposals.map((p) => [p.n, p.status]));
		expect(byN.get(1)).toBe("applied");
		expect(byN.get(2)).toBe("pending");
		expect(byN.get(3)).toBe("applied");
		expect(updated.length).toBeGreaterThan(0);
	});

	it("captures with provenance pointing at the report and target ids", async () => {
		const report = makeReport([
			proposal(1, { target_ids: ["existing-1"], proposed_content: "Updated fact." }),
		]);
		const { db, inserted } = createFakeDb({ thoughtsById: { "report-1": report } });
		const ai = fakeAi();

		await applyProposals({ db, ai }, "report-1", [1]);

		const captured = inserted.find((t) => t.content === "Updated fact.");
		expect(captured).toBeTruthy();
	});

	function existingThought(id: string, content: string, overrides: Partial<Row> = {}): Row {
		return {
			id,
			content,
			embedding: [0.1, 0.2, 0.3],
			metadata: {},
			version: 1,
			created_at: "2026-08-01T00:00:00Z",
			due_at: null,
			recurrence: null,
			parent_id: null,
			expires_at: null,
			...overrides,
		};
	}

	it("action=update mutates the TARGET thought's content — never inserts a new one", async () => {
		const report = makeReport([
			proposal(1, {
				action: "update",
				target_ids: ["existing-1"],
				proposed_content: "New content.",
			}),
		]);
		const { db, inserted, thoughtsById } = createFakeDb({
			thoughtsById: {
				"report-1": report,
				"existing-1": existingThought("existing-1", "Old content."),
			},
		});
		const ai = fakeAi();

		const outcomes = await applyProposals({ db, ai }, "report-1", [1]);

		expect(outcomes).toEqual([{ n: 1, status: "applied", thoughtId: "existing-1" }]);
		expect(thoughtsById["existing-1"].content).toBe("New content.");
		expect(inserted.find((t) => t.content === "New content.")).toBeUndefined();
	});

	it("action=supersede mutates the TARGET thought's content — never inserts a new one", async () => {
		const report = makeReport([
			proposal(1, {
				action: "supersede",
				target_ids: ["existing-1"],
				proposed_content: "Corrected content.",
			}),
		]);
		const { db, inserted, thoughtsById } = createFakeDb({
			thoughtsById: {
				"report-1": report,
				"existing-1": existingThought("existing-1", "Wrong content."),
			},
		});
		const ai = fakeAi();

		const outcomes = await applyProposals({ db, ai }, "report-1", [1]);

		expect(outcomes).toEqual([{ n: 1, status: "applied", thoughtId: "existing-1" }]);
		expect(thoughtsById["existing-1"].content).toBe("Corrected content.");
		expect(inserted.find((t) => t.content === "Corrected content.")).toBeUndefined();
	});

	it("action=merge mutates the primary target and expires the rest — never inserts a third row", async () => {
		const report = makeReport([
			proposal(1, {
				action: "merge",
				target_ids: ["primary-1", "dup-1"],
				proposed_content: "Merged content.",
			}),
		]);
		const { db, inserted, thoughtsById } = createFakeDb({
			thoughtsById: {
				"report-1": report,
				"primary-1": existingThought("primary-1", "loves pizza"),
				"dup-1": existingThought("dup-1", "loves pizza"),
			},
		});
		const ai = fakeAi();

		const outcomes = await applyProposals({ db, ai }, "report-1", [1]);

		expect(outcomes).toEqual([{ n: 1, status: "applied", thoughtId: "primary-1" }]);
		expect(thoughtsById["primary-1"].content).toBe("Merged content.");
		expect(thoughtsById["dup-1"].expires_at).toBeTruthy();
		expect(thoughtsById["dup-1"].content).toBe("loves pizza"); // untouched, only hidden
		expect(inserted.find((t) => t.content === "Merged content.")).toBeUndefined();
	});

	it("action=expire sets expires_at on every target and inserts / updates content nowhere", async () => {
		const report = makeReport([
			proposal(1, {
				action: "expire",
				target_ids: ["stale-1"],
				proposed_content: "old address", // display-only, must never be captured
			}),
		]);
		const { db, inserted, thoughtsById } = createFakeDb({
			thoughtsById: {
				"report-1": report,
				"stale-1": existingThought("stale-1", "old address"),
			},
		});
		const ai = fakeAi();

		const outcomes = await applyProposals({ db, ai }, "report-1", [1]);

		expect(outcomes).toEqual([{ n: 1, status: "applied" }]);
		expect(thoughtsById["stale-1"].expires_at).toBeTruthy();
		expect(thoughtsById["stale-1"].content).toBe("old address"); // content itself untouched
		// Nothing was ever captured for an expire — inserted stays empty.
		expect(inserted).toHaveLength(0);
	});

	it("refuses (loud error, no write) when a content-requiring action gets empty proposed_content", async () => {
		const report = makeReport([
			proposal(1, {
				action: "supersede",
				target_ids: ["c1", "c2"],
				proposed_content: "", // e.g. an un-resolved contradiction, per lintFindingsToProposals
			}),
		]);
		const { db, inserted, thoughtsById } = createFakeDb({
			thoughtsById: {
				"report-1": report,
				c1: existingThought("c1", "Address A"),
				c2: existingThought("c2", "Address B"),
			},
		});
		const ai = fakeAi();

		const outcomes = await applyProposals({ db, ai }, "report-1", [1]);

		expect(outcomes[0].status).toBe("error");
		expect(inserted).toHaveLength(0);
		expect(thoughtsById.c1.content).toBe("Address A");
		expect(thoughtsById.c2.content).toBe("Address B");

		const finalMeta = thoughtsById["report-1"].metadata as { dream: DreamReportMetadata };
		// Never silently marked applied on failure.
		expect(finalMeta.dream.proposals[0].status).toBe("pending");
	});

	it("refuses (loud error, no write) when a target-requiring action gets no target_ids", async () => {
		const report = makeReport([
			proposal(1, { action: "expire", target_ids: [], proposed_content: "orphaned" }),
		]);
		const { db, inserted, updated } = createFakeDb({
			thoughtsById: { "report-1": report },
		});
		const ai = fakeAi();

		const before = updated.length;
		const outcomes = await applyProposals({ db, ai }, "report-1", [1]);

		expect(outcomes[0].status).toBe("error");
		expect(inserted).toHaveLength(0);
		// The only update that can legitimately happen is persistDreamMeta's
		// own metadata patch on the report — never a thought mutation for the
		// (nonexistent) target.
		expect(updated.length).toBe(before + 1);
	});
});

/**
 * Containment is the single highest-consequence invariant in this design: a
 * dream report lives in the same `thoughts` table as real memories, so the
 * only things keeping proposals out of search, listing, lint, relation
 * detection and page compilation are `is_bundle: true` (checked by
 * search.ts, NON_BUNDLE_FILTER, capture.ts and topic-pages.ts) and an
 * `expires_at` horizon enforced in SQL by hybrid_search. If either regresses,
 * every proposal quietly becomes a searchable memory quoting the transcript
 * — so these assertions are deliberately literal.
 */
describe("writeDreamReport containment", () => {
	const NOW = new Date("2026-08-04T03:00:00Z");

	function makeResult(overrides: Partial<DreamResult> = {}): DreamResult {
		return {
			proposals: [
				{
					n: 1,
					pid: "dream:2026-08-04#1",
					category: "new_fact",
					action: "create",
					target_ids: [],
					proposed_content: "SENTINEL_PROPOSAL_BODY",
					evidence: {
						quote: "SENTINEL_EVIDENCE_QUOTE",
						session_id: "sess-1",
						turn_index: 1,
						transcript_path: "/tmp/sess-1.jsonl",
						at: "2026-08-03T12:00:00Z",
					},
					confidence: 0.9,
					rationale: "because",
					fingerprint: "fp-1",
					status: "pending",
				},
			],
			scanned: { turns: 1, sessions: 1 },
			usage: { inputTokens: 100, outputTokens: 20 },
			health: { newest_capture_at: "2026-08-04T00:00:00Z", capture_pipeline_stale: false },
			truncated: false,
			dropped: 0,
			window: { from: "2026-08-03T00:00:00Z", to: "2026-08-04T00:00:00Z" },
			now: NOW,
			...overrides,
		};
	}

	it("writes a bundle row that no ordinary read path can return", async () => {
		const { db, inserted } = createFakeDb();
		const ai = fakeAi();

		await writeDreamReport({ db, ai }, makeResult(), "dream:2026-08-04");

		expect(inserted).toHaveLength(1);
		const row = inserted[0];
		expect(row.is_bundle).toBe(true);
		expect(row.source_kind).toBe("dream-report");
		expect(row.source_id).toBe("dream:2026-08-04");
	});

	it("embeds a bland anchor, never the proposal text or evidence", async () => {
		const { db, inserted } = createFakeDb();
		const ai = fakeAi();

		await writeDreamReport({ db, ai }, makeResult(), "dream:2026-08-04");

		const row = inserted[0];
		expect(row.content).toBe("Echo dream report 2026-08-04");
		// The embedded content is what search would match on. It must not
		// carry proposal text, or the report becomes semantically adjacent to
		// the very memories it is about.
		expect(String(row.content)).not.toContain("SENTINEL_PROPOSAL_BODY");
		expect(String(row.content)).not.toContain("SENTINEL_EVIDENCE_QUOTE");
	});

	it("sets a 14-day expiry derived from the injected clock", async () => {
		const { db, inserted } = createFakeDb();
		const ai = fakeAi();

		await writeDreamReport({ db, ai }, makeResult(), "dream:2026-08-04");

		const expiresAt = new Date(String(inserted[0].expires_at)).getTime();
		const expected = NOW.getTime() + 14 * 24 * 60 * 60 * 1000;
		expect(expiresAt).toBe(expected);
	});

	it("records the real cost rather than a hardcoded zero", async () => {
		const { db, inserted } = createFakeDb();
		const ai = fakeAi();

		await writeDreamReport({ db, ai }, makeResult(), "dream:2026-08-04");

		const meta = inserted[0].metadata as { dream: DreamReportMetadata };
		expect(meta.dream.cost_usd).toBeGreaterThan(0);
		expect(meta.dream.window).toEqual({
			from: "2026-08-03T00:00:00Z",
			to: "2026-08-04T00:00:00Z",
		});
	});

	it("is idempotent on source_id — a re-run writes nothing new", async () => {
		const { db, inserted } = createFakeDb();
		const ai = fakeAi();

		const first = await writeDreamReport({ db, ai }, makeResult(), "dream:2026-08-04");
		expect(first.duplicate).toBe(false);

		const second = await writeDreamReport({ db, ai }, makeResult(), "dream:2026-08-04");
		expect(second.duplicate).toBe(true);
		expect(second.id).toBe(first.id);
		expect(inserted).toHaveLength(1);
	});

	it("round-trips through getDreamReport", async () => {
		const { db } = createFakeDb();
		const ai = fakeAi();

		const { id } = await writeDreamReport({ db, ai }, makeResult(), "dream:2026-08-04");

		const byId = await getDreamReport(db, { sourceId: "dream:2026-08-04" });
		expect(byId?.id).toBe(id);
		expect(byId?.metadata.dream.proposals[0].proposed_content).toBe("SENTINEL_PROPOSAL_BODY");

		const latest = await getDreamReport(db);
		expect(latest?.id).toBe(id);
	});

	it("returns null when no report exists", async () => {
		const { db } = createFakeDb();
		expect(await getDreamReport(db)).toBeNull();
		expect(await getDreamReport(db, { sourceId: "dream:1970-01-01" })).toBeNull();
	});
});

describe("rejectProposals and fingerprint suppression", () => {
	it("marks a proposal rejected with its note and never writes a thought", async () => {
		const dreamMeta: DreamReportMetadata = {
			run_at: "2026-08-04T00:00:00Z",
			window: { from: "2026-08-03", to: "2026-08-04" },
			scanned: { turns: 1, sessions: 1 },
			cost_usd: 0.01,
			auto_applied: [],
			proposals: [
				{
					n: 1,
					pid: "dream:2026-08-04#1",
					category: "new_fact",
					action: "create",
					target_ids: [],
					proposed_content: "Not a real memory.",
					evidence: {
						quote: "q",
						session_id: "sess-1",
						turn_index: 1,
						transcript_path: "/tmp/s.jsonl",
						at: "2026-08-03T12:00:00Z",
					},
					confidence: 0.6,
					rationale: "because",
					fingerprint: "fp-reject-me",
					status: "pending",
				},
			],
			health: { newest_capture_at: null, capture_pipeline_stale: false },
		};
		const report = {
			id: "report-1",
			content: "Echo dream report 2026-08-04",
			metadata: { dream: dreamMeta },
			version: 1,
			created_at: "2026-08-04T00:00:00Z",
			due_at: null,
			recurrence: null,
			parent_id: null,
		};
		const { db, thoughtsById, inserted } = createFakeDb({
			thoughtsById: { "report-1": report },
		});
		const ai = fakeAi();

		const outcomes = await rejectProposals({ db, ai }, "report-1", [1], "already knew this");

		expect(outcomes[0].status).toBe("rejected");
		const finalMeta = thoughtsById["report-1"].metadata as { dream: DreamReportMetadata };
		expect(finalMeta.dream.proposals[0].status).toBe("rejected");
		expect(finalMeta.dream.proposals[0].resolution_note).toBe("already knew this");
		// Rejecting must never create a memory.
		expect(inserted).toHaveLength(0);
	});

	it("feeds rejected fingerprints back so the same proposal isn't re-raised", async () => {
		const rejected: DreamReportMetadata = {
			run_at: "2026-08-03T03:00:00Z",
			window: { from: "2026-08-02", to: "2026-08-03" },
			scanned: { turns: 1, sessions: 1 },
			cost_usd: 0.01,
			auto_applied: [],
			proposals: [
				{
					n: 1,
					pid: "dream:2026-08-03#1",
					category: "new_fact",
					action: "create",
					target_ids: [],
					proposed_content: "Nope.",
					evidence: {
						quote: "q",
						session_id: "s",
						turn_index: 1,
						transcript_path: "/tmp/s.jsonl",
						at: "2026-08-02T12:00:00Z",
					},
					confidence: 0.6,
					rationale: "because",
					fingerprint: "fp-rejected",
					status: "rejected",
				},
				{
					n: 2,
					pid: "dream:2026-08-03#2",
					category: "new_fact",
					action: "create",
					target_ids: [],
					proposed_content: "Yes.",
					evidence: {
						quote: "q",
						session_id: "s",
						turn_index: 2,
						transcript_path: "/tmp/s.jsonl",
						at: "2026-08-02T12:00:00Z",
					},
					confidence: 0.6,
					rationale: "because",
					fingerprint: "fp-applied",
					status: "applied",
				},
			],
			health: { newest_capture_at: null, capture_pipeline_stale: false },
		};
		const { db } = createFakeDb({ facts: [{ metadata: { dream: rejected } }] });

		const fingerprints = await listRecentFingerprints(db, 30);

		// Only rejections suppress. An applied proposal must not be suppressed,
		// or a later genuine change to the same memory would go unreported.
		expect(fingerprints.has("fp-rejected")).toBe(true);
		expect(fingerprints.has("fp-applied")).toBe(false);
	});
});

/**
 * Opt-in perf harness: prints p50/p95, never fails on a latency number.
 * Runs only when ECHO_PERF=1 AND the local `supabase start` stack is up:
 *
 *   ECHO_PERF=1 bun run test:perf
 *
 * Seeds ~10k synthetic thoughts and ~2k entities / ~4k co-occurrence edges
 * with deterministic fake embeddings (seeded PRNG — no model calls), then
 * measures (a) the hybrid_search RPC and (b) the entity-graph projection +
 * on-demand analytics. (b) exists because ADR-0018 names its persistence
 * trigger — "once the graph grows past ~1–2k nodes that recompute adds
 * perceptible latency" — so this prints the number that decision waits on.
 * Tune with ECHO_PERF_THOUGHTS / ECHO_PERF_ENTITIES / ECHO_PERF_RUNS.
 */

import { entityGraph, toWeightedGraph } from "@shared/entity-graph.ts";
import { communities, weightedDegree } from "@shared/graph-analysis.ts";
import { afterAll, describe, expect, it } from "vitest";
import { DIMS, deleteTagged, probeLocalStack, serviceClient } from "../integration/local-stack.ts";

const PERF_ON = process.env.ECHO_PERF === "1";
const ready = PERF_ON ? await probeLocalStack() : false;
if (PERF_ON && !ready) {
	console.warn("[perf] local supabase stack unreachable — skipping perf harness");
}

const THOUGHT_COUNT = Number(process.env.ECHO_PERF_THOUGHTS ?? 10_000);
const ENTITY_COUNT = Number(process.env.ECHO_PERF_ENTITIES ?? 2_000);
const EDGE_COUNT = ENTITY_COUNT * 2;
const RUNS = Number(process.env.ECHO_PERF_RUNS ?? 30);
const BATCH = 200;
const TAG = `perf-${Date.now()}`;

const db = serviceClient();

// mulberry32 — deterministic embeddings without a model.
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function fakeVector(seed: number): number[] {
	const next = rng(seed);
	const v = Array.from({ length: DIMS }, () => next() - 0.5);
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
	return v.map((x) => x / norm);
}

function percentiles(times: number[]): { p50: number; p95: number } {
	const sorted = [...times].sort((a, b) => a - b);
	return {
		p50: sorted[Math.floor(sorted.length / 2)],
		p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
	};
}

async function seedThoughtCorpus(): Promise<void> {
	for (let start = 0; start < THOUGHT_COUNT; start += BATCH) {
		const rows = [];
		for (let i = start; i < Math.min(start + BATCH, THOUGHT_COUNT); i++) {
			rows.push({
				content: `synthetic thought ${i} about topic_${i % 500} and concept_${i % 97}`,
				embedding: JSON.stringify(fakeVector(i)),
				metadata: { test_tag: TAG, memory_type: "fact", topics: [`topic_${i % 500}`] },
			});
		}
		const { error } = await db.from("thoughts").insert(rows);
		if (error) throw new Error(`thought seed failed at ${start}: ${error.message}`);
	}
}

async function seedEntityGraph(): Promise<void> {
	const ids: string[] = [];
	for (let start = 0; start < ENTITY_COUNT; start += BATCH) {
		const rows = [];
		for (let i = start; i < Math.min(start + BATCH, ENTITY_COUNT); i++) {
			rows.push({
				type: "tool" as const,
				canonical_name: `${TAG}-entity-${i}`,
				mention_count: 1 + (i % 20),
			});
		}
		const { data, error } = await db.from("entities").insert(rows).select("id");
		if (error) throw new Error(`entity seed failed at ${start}: ${error.message}`);
		ids.push(...(data as { id: string }[]).map((r) => r.id));
	}

	// Ring + random chords: connected, weight-varied, deterministic.
	const next = rng(42);
	const edges = new Map<string, { source_id: string; target_id: string; weight: number }>();
	const addEdge = (a: number, b: number, weight: number) => {
		if (a === b) return;
		const [s, t] = ids[a] < ids[b] ? [ids[a], ids[b]] : [ids[b], ids[a]];
		edges.set(`${s}:${t}`, { source_id: s, target_id: t, weight });
	};
	for (let i = 0; i < ENTITY_COUNT; i++) addEdge(i, (i + 1) % ENTITY_COUNT, 1 + (i % 5));
	while (edges.size < EDGE_COUNT) {
		addEdge(
			Math.floor(next() * ENTITY_COUNT),
			Math.floor(next() * ENTITY_COUNT),
			1 + Math.floor(next() * 5),
		);
	}
	const edgeRows = [...edges.values()];
	for (let start = 0; start < edgeRows.length; start += BATCH) {
		const { error } = await db.from("entity_edges").insert(edgeRows.slice(start, start + BATCH));
		if (error) throw new Error(`edge seed failed at ${start}: ${error.message}`);
	}
}

afterAll(async () => {
	if (!ready) return;
	await deleteTagged(db, TAG);
	await db.from("entities").delete().like("canonical_name", `${TAG}-entity-%`);
});

describe.skipIf(!ready)("perf harness (printed, never gated)", () => {
	it(`hybrid_search p50/p95 @ ~${THOUGHT_COUNT} thoughts`, async () => {
		await seedThoughtCorpus();

		// Warm up plan caches / index pages before timing.
		await db.rpc("hybrid_search", {
			query_text: "topic_1",
			query_embedding: fakeVector(1),
			match_threshold: 0.3,
			match_count: 10,
			alpha: 0.7,
			filter: {},
		});

		const times: number[] = [];
		const next = rng(7);
		for (let i = 0; i < RUNS; i++) {
			const n = Math.floor(next() * THOUGHT_COUNT);
			const t0 = performance.now();
			const { error } = await db.rpc("hybrid_search", {
				query_text: `topic_${n % 500} concept_${n % 97}`,
				query_embedding: fakeVector(n),
				match_threshold: 0.3,
				match_count: 10,
				alpha: 0.7,
				filter: {},
			});
			if (error) throw new Error(error.message);
			times.push(performance.now() - t0);
		}
		const { p50, p95 } = percentiles(times);
		console.log(
			`[perf] hybrid_search p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms over ${RUNS} runs @ ${THOUGHT_COUNT} thoughts`,
		);
		expect(times).toHaveLength(RUNS);
	}, 600_000);

	it(`entity-graph projection + analytics p50/p95 @ ~${ENTITY_COUNT} entities (ADR-0018 threshold)`, async () => {
		await seedEntityGraph();

		const projectionTimes: number[] = [];
		const analysisTimes: number[] = [];
		for (let i = 0; i < RUNS; i++) {
			const t0 = performance.now();
			const graph = await entityGraph(db);
			projectionTimes.push(performance.now() - t0);

			const t1 = performance.now();
			const weighted = toWeightedGraph(graph);
			communities(weighted);
			weightedDegree(weighted);
			analysisTimes.push(performance.now() - t1);
		}
		const proj = percentiles(projectionTimes);
		const anal = percentiles(analysisTimes);
		console.log(
			`[perf] entityGraph read p50=${proj.p50.toFixed(1)}ms p95=${proj.p95.toFixed(1)}ms; ` +
				`communities+degree p50=${anal.p50.toFixed(1)}ms p95=${anal.p95.toFixed(1)}ms @ ${ENTITY_COUNT} nodes ` +
				"(ADR-0018 parks persistence until this is perceptible)",
		);
		expect(projectionTimes).toHaveLength(RUNS);
	}, 600_000);
});

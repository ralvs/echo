/**
 * Graph analysis — pure algorithms over a minimal, neutral weighted graph.
 *
 * This module knows nothing about thoughts, entities, names, or types: a graph
 * is a set of node ids and weighted undirected edges between them. Callers
 * (entity-graph adapters, the find_path / graph_overview MCP tools, the
 * dashboard) project their domain objects down to this shape, run an
 * algorithm, and map the returned ids back. Keeping the model id-only is what
 * makes every function here a pure, deterministic, dependency-free unit — the
 * same "keep the graph model neutral, let the renderer slice it" discipline
 * ADR-0015 records for relation-graph.ts, taken one step further (no db, no ai).
 *
 * Determinism is a hard contract. Every traversal iterates nodes/neighbours in
 * sorted id order and breaks ties on the lower id, so identical input always
 * yields an identical partition, path, or ranking — tests can assert exact
 * results and the digest never reshuffles between two identical calls.
 */

export type WeightedGraph = {
	nodes: string[];
	edges: { source: string; target: string; weight: number }[];
};

type Neighbour = { to: string; cost: number };
type Adjacency = Map<string, Neighbour[]>;

/** Lexicographic id comparison — the single tie-break rule for the module. */
function byId(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build an undirected adjacency list. Edge cost is the inverse of co-occurrence
 * weight (a stronger tie is a shorter distance), and dangling edges — endpoints
 * absent from `nodes` — are dropped so every downstream walk stays inside the
 * node set. Neighbour lists are sorted by id to keep traversal deterministic.
 */
function buildAdjacency(graph: WeightedGraph): Adjacency {
	const adj: Adjacency = new Map();
	for (const id of graph.nodes) adj.set(id, []);

	for (const e of graph.edges) {
		const from = adj.get(e.source);
		const to = adj.get(e.target);
		if (!from || !to || e.source === e.target) continue;
		const cost = e.weight > 0 ? 1 / e.weight : Number.POSITIVE_INFINITY;
		from.push({ to: e.target, cost });
		to.push({ to: e.source, cost });
	}

	for (const list of adj.values()) list.sort((x, y) => byId(x.to, y.to));
	return adj;
}

export type Path = { path: string[]; cost: number };

/**
 * Shortest weighted path between two node ids via Dijkstra (cost = 1/weight).
 * Returns the node sequence and total cost, or `null` when either endpoint is
 * absent or the two sit in disconnected components. A node to itself is a
 * zero-cost single-node path.
 *
 * Implemented with a linear min-scan rather than a heap: the personal-knowledge
 * graphs this runs on are hundreds of nodes, where O(V²) is instantaneous and
 * obviously correct, and the (dist, id) selection keeps the chosen path
 * deterministic without heap-staleness bookkeeping.
 */
export function shortestPath(graph: WeightedGraph, from: string, to: string): Path | null {
	const adj = buildAdjacency(graph);
	if (!adj.has(from) || !adj.has(to)) return null;
	if (from === to) return { path: [from], cost: 0 };

	const dist = new Map<string, number>();
	const prev = new Map<string, string>();
	const visited = new Set<string>();
	dist.set(from, 0);

	for (;;) {
		// Pick the unvisited node with the smallest (distance, id).
		let current: string | null = null;
		let best = Number.POSITIVE_INFINITY;
		for (const [id, d] of dist) {
			if (visited.has(id)) continue;
			if (d < best || (d === best && current !== null && byId(id, current) < 0)) {
				best = d;
				current = id;
			}
		}
		if (current === null) break;
		if (current === to) break;
		visited.add(current);

		for (const { to: next, cost } of adj.get(current) ?? []) {
			if (visited.has(next)) continue;
			const nd = best + cost;
			const known = dist.get(next);
			if (known === undefined || nd < known) {
				dist.set(next, nd);
				prev.set(next, current);
			} else if (nd === known) {
				// Equal-cost tie: keep the lower-id predecessor for a stable path.
				const existing = prev.get(next);
				if (existing === undefined || byId(current, existing) < 0) prev.set(next, current);
			}
		}
	}

	if (!dist.has(to)) return null;

	const path: string[] = [];
	let step: string | undefined = to;
	while (step !== undefined) {
		path.unshift(step);
		step = prev.get(step);
	}
	return { path, cost: dist.get(to) ?? Number.POSITIVE_INFINITY };
}

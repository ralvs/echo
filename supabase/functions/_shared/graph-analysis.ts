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

type WeightedNeighbour = { to: string; weight: number };

/**
 * Build an undirected adjacency list carrying raw co-occurrence weight (not the
 * inverted cost Dijkstra wants). Drops dangling/self edges; sorts neighbours by
 * id for deterministic iteration.
 */
function buildWeightedAdjacency(graph: WeightedGraph): Map<string, WeightedNeighbour[]> {
	const adj = new Map<string, WeightedNeighbour[]>();
	for (const id of graph.nodes) adj.set(id, []);
	for (const e of graph.edges) {
		const from = adj.get(e.source);
		const to = adj.get(e.target);
		if (!from || !to || e.source === e.target) continue;
		from.push({ to: e.target, weight: e.weight });
		to.push({ to: e.source, weight: e.weight });
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

/**
 * Weighted degree per node — the summed co-occurrence weight of its incident
 * edges. This is the "god node" signal: the entities woven through the most of
 * your thinking score highest.
 */
export function weightedDegree(graph: WeightedGraph): Map<string, number> {
	const degree = new Map<string, number>();
	for (const id of graph.nodes) degree.set(id, 0);
	for (const e of graph.edges) {
		if (e.source === e.target) continue;
		const s = degree.get(e.source);
		const t = degree.get(e.target);
		if (s === undefined || t === undefined) continue;
		degree.set(e.source, s + e.weight);
		degree.set(e.target, t + e.weight);
	}
	return degree;
}

const LABEL_PROPAGATION_MAX_ITERATIONS = 100;

/**
 * Partition the graph into communities by weighted label propagation: every
 * node repeatedly adopts the label carrying the most incident weight among its
 * neighbours. Cheap (no resolution parameter to tune), and good enough for a
 * few-hundred-node personal graph; Louvain/Leiden is the upgrade path if
 * cluster quality ever disappoints.
 *
 * Made deterministic so the partition is reproducible and tests can assert it:
 * nodes are visited in sorted-id order with synchronous in-place updates, ties
 * break to the lowest label id, and a fixed iteration cap guarantees
 * termination. Returns a node id → community index map; isolated nodes are
 * their own singleton community. Community indices are normalised to a
 * contiguous range ordered by each community's lowest member id.
 */
export function communities(graph: WeightedGraph): Map<string, number> {
	const adj = buildWeightedAdjacency(graph);
	const nodes = [...graph.nodes].sort(byId);

	// Label space is the node ids themselves; each node starts in its own.
	const label = new Map<string, string>();
	for (const id of nodes) label.set(id, id);

	for (let iter = 0; iter < LABEL_PROPAGATION_MAX_ITERATIONS; iter++) {
		let changed = false;
		for (const id of nodes) {
			const neighbours = adj.get(id);
			if (!neighbours || neighbours.length === 0) continue;

			const score = new Map<string, number>();
			for (const { to, weight } of neighbours) {
				const l = label.get(to);
				if (l === undefined) continue;
				score.set(l, (score.get(l) ?? 0) + weight);
			}

			// Highest summed weight wins; lowest label id breaks ties.
			let best = label.get(id) ?? id;
			let bestScore = -1;
			for (const [l, s] of [...score].sort((a, b) => byId(a[0], b[0]))) {
				if (s > bestScore) {
					bestScore = s;
					best = l;
				}
			}
			if (best !== label.get(id)) {
				label.set(id, best);
				changed = true;
			}
		}
		if (!changed) break;
	}

	return normaliseCommunities(nodes, label);
}

/** Relabel arbitrary label ids to contiguous indices ordered by lowest member. */
function normaliseCommunities(nodes: string[], label: Map<string, string>): Map<string, number> {
	const members = new Map<string, string[]>();
	for (const id of nodes) {
		// nodes is sorted, so the first id pushed into each group is its lowest.
		const l = label.get(id) ?? id;
		const group = members.get(l);
		if (group) group.push(id);
		else members.set(l, [id]);
	}

	const ordered = [...members.entries()].sort((a, b) => byId(a[1][0], b[1][0]));
	const result = new Map<string, number>();
	ordered.forEach(([, group], index) => {
		for (const id of group) result.set(id, index);
	});
	return result;
}

/**
 * Edges that cross between communities, strongest first — the "surprising
 * connections" signal. A high-weight tie between two otherwise-separate
 * clusters (a person bridging your work and your hobby, say) is exactly the
 * link worth reflecting on. O(E) once communities are known.
 */
export function crossCommunityEdges(
	graph: WeightedGraph,
	community: Map<string, number>,
): { source: string; target: string; weight: number }[] {
	const present = new Set(graph.nodes);
	return graph.edges
		.filter(
			(e) =>
				e.source !== e.target &&
				present.has(e.source) &&
				present.has(e.target) &&
				community.get(e.source) !== community.get(e.target),
		)
		.sort((a, b) => b.weight - a.weight || byId(a.source, b.source) || byId(a.target, b.target));
}

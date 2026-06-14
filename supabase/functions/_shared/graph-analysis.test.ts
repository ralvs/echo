import { describe, expect, it } from "vitest";
import {
	communities,
	crossCommunityEdges,
	shortestPath,
	type WeightedGraph,
	weightedDegree,
} from "./graph-analysis.ts";

// a—b—d with a strong direct a—d edge; {p, q} is a disconnected component;
// iso is isolated; the a—ghost edge is dangling (ghost is not a node).
const GRAPH: WeightedGraph = {
	nodes: ["a", "b", "d", "iso", "p", "q"],
	edges: [
		{ source: "a", target: "b", weight: 1 },
		{ source: "b", target: "d", weight: 1 },
		{ source: "a", target: "d", weight: 2 },
		{ source: "p", target: "q", weight: 3 },
		{ source: "a", target: "ghost", weight: 5 },
	],
};

describe("shortestPath", () => {
	it("returns a zero-cost single-node path to itself", () => {
		expect(shortestPath(GRAPH, "a", "a")).toEqual({ path: ["a"], cost: 0 });
	});

	it("prefers the stronger (higher-weight) edge as the shorter route", () => {
		// Direct a—d (weight 2 → cost 0.5) beats a—b—d (cost 1 + 1 = 2).
		expect(shortestPath(GRAPH, "a", "d")).toEqual({ path: ["a", "d"], cost: 0.5 });
	});

	it("returns null across disconnected components", () => {
		expect(shortestPath(GRAPH, "a", "p")).toBe(null);
		expect(shortestPath(GRAPH, "a", "iso")).toBe(null);
	});

	it("returns null when an endpoint is absent", () => {
		expect(shortestPath(GRAPH, "a", "nope")).toBe(null);
		expect(shortestPath(GRAPH, "nope", "a")).toBe(null);
	});

	it("ignores dangling edges instead of crashing", () => {
		// The a—ghost edge must not produce a node or a usable hop.
		expect(shortestPath(GRAPH, "a", "ghost")).toBe(null);
	});

	it("breaks equal-cost ties deterministically on the lower id", () => {
		const tie: WeightedGraph = {
			nodes: ["s", "m", "n", "t"],
			edges: [
				{ source: "s", target: "m", weight: 1 },
				{ source: "s", target: "n", weight: 1 },
				{ source: "m", target: "t", weight: 1 },
				{ source: "n", target: "t", weight: 1 },
			],
		};
		// Both s—m—t and s—n—t cost 2; the lower-id predecessor (m) wins.
		expect(shortestPath(tie, "s", "t")).toEqual({ path: ["s", "m", "t"], cost: 2 });
	});
});

// Two strong triangles {a,b,c} and {x,y,z} joined by a single weak c—x bridge,
// plus an isolated node. The canonical clustering fixture.
const CLUSTERED: WeightedGraph = {
	nodes: ["a", "b", "c", "x", "y", "z", "iso"],
	edges: [
		{ source: "a", target: "b", weight: 5 },
		{ source: "b", target: "c", weight: 5 },
		{ source: "a", target: "c", weight: 5 },
		{ source: "x", target: "y", weight: 5 },
		{ source: "y", target: "z", weight: 5 },
		{ source: "x", target: "z", weight: 5 },
		{ source: "c", target: "x", weight: 1 },
	],
};

describe("weightedDegree", () => {
	it("sums incident edge weights, zero for isolated nodes", () => {
		const deg = weightedDegree(CLUSTERED);
		expect(deg.get("a")).toBe(10); // a—b (5) + a—c (5)
		expect(deg.get("c")).toBe(11); // b—c (5) + a—c (5) + c—x (1)
		expect(deg.get("iso")).toBe(0);
	});
});

describe("communities", () => {
	it("separates the two triangles and isolates the lone node", () => {
		const comm = communities(CLUSTERED);
		// Each triangle is one community; the weak bridge does not merge them.
		expect(comm.get("a")).toBe(comm.get("b"));
		expect(comm.get("a")).toBe(comm.get("c"));
		expect(comm.get("x")).toBe(comm.get("y"));
		expect(comm.get("x")).toBe(comm.get("z"));
		expect(comm.get("a")).not.toBe(comm.get("x"));
		expect(comm.get("iso")).not.toBe(comm.get("a"));
		expect(comm.get("iso")).not.toBe(comm.get("x"));
		expect(new Set(comm.values()).size).toBe(3);
	});

	it("normalises community indices by lowest member id", () => {
		const comm = communities(CLUSTERED);
		// Communities ordered by lowest member: {a..}=0, {iso}=1, {x..}=2.
		expect(comm.get("a")).toBe(0);
		expect(comm.get("iso")).toBe(1);
		expect(comm.get("x")).toBe(2);
	});
});

describe("crossCommunityEdges", () => {
	it("returns only the inter-community bridge", () => {
		const comm = communities(CLUSTERED);
		expect(crossCommunityEdges(CLUSTERED, comm)).toEqual([{ source: "c", target: "x", weight: 1 }]);
	});
});

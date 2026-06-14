import { describe, expect, it } from "vitest";
import { shortestPath, type WeightedGraph } from "./graph-analysis.ts";

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

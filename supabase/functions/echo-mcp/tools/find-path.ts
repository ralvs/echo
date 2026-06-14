import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { entityGraph, toWeightedGraph } from "../../_shared/entity-graph.ts";
import { shortestPath } from "../../_shared/graph-analysis.ts";
import { supabase } from "../config.ts";
import { registerTextTool, ToolError } from "./contract.ts";

type ResolvedEntity = { id: string; type: string; canonical_name: string };

/**
 * Resolve an entity by canonical name (optionally narrowed by type). A bare
 * name that matches more than one type is reported as ambiguous rather than
 * silently picking one — the same uniqueness story as get_entity, but a path
 * between the wrong nodes is worse than an error. Alias matching is out of
 * scope for v1 (canonical names only).
 */
async function resolveEntity(name: string, type?: string): Promise<ResolvedEntity> {
	let query = supabase
		.from("entities")
		.select("id, type, canonical_name")
		.eq("canonical_name", name);
	if (type) query = query.eq("type", type);

	const { data, error } = await query;
	if (error) throw new ToolError(`Error: ${error.message}`);

	const matches = (data ?? []) as ResolvedEntity[];
	if (matches.length === 0) {
		throw new ToolError(`Entity not found: ${name}${type ? ` (${type})` : ""}`);
	}
	if (matches.length > 1) {
		const candidates = matches.map((m) => `${m.canonical_name} (${m.type})`).join(", ");
		throw new ToolError(
			`"${name}" is ambiguous — pass a type to narrow it. Candidates: ${candidates}`,
		);
	}
	return matches[0];
}

export function registerFindPath(server: McpServer) {
	registerTextTool(
		server,
		"find_path",
		{
			title: "Find Path",
			description:
				"Find how two entities connect through the co-occurrence graph — the shortest chain of shared thoughts linking, say, a person to a project. Answers 'how are X and Y related?'. Returns the chain with co-occurrence strength on each hop, or reports no connection.",
			inputSchema: {
				from: z.string().describe("Canonical name of the first entity, e.g. 'Sarah'"),
				to: z.string().describe("Canonical name of the second entity, e.g. 'Project X'"),
				from_type: z
					.enum(["person", "project", "organization", "tool", "place"])
					.optional()
					.describe("Narrow the first name to a single type if it is ambiguous"),
				to_type: z
					.enum(["person", "project", "organization", "tool", "place"])
					.optional()
					.describe("Narrow the second name to a single type if it is ambiguous"),
			},
		},
		async ({ from, to, from_type, to_type }) => {
			const a = await resolveEntity(from, from_type);
			const b = await resolveEntity(to, to_type);
			if (a.id === b.id) return `${a.canonical_name} and ${to} resolve to the same entity.`;

			const graph = await entityGraph(supabase);
			const result = shortestPath(toWeightedGraph(graph), a.id, b.id);
			if (!result) {
				return `No connection found between ${a.canonical_name} and ${b.canonical_name}. They have never been mentioned in a chain of shared thoughts.`;
			}

			const nameById = new Map(graph.nodes.map((n) => [n.id, n.name]));
			const weightBetween = (x: string, y: string): number | null => {
				const e = graph.edges.find(
					(ed) =>
						(ed.source_id === x && ed.target_id === y) ||
						(ed.source_id === y && ed.target_id === x),
				);
				return e ? e.weight : null;
			};

			const segments: string[] = [nameById.get(result.path[0]) ?? result.path[0]];
			for (let i = 1; i < result.path.length; i++) {
				const w = weightBetween(result.path[i - 1], result.path[i]);
				segments.push(w !== null ? `—${w}×—` : "—");
				segments.push(nameById.get(result.path[i]) ?? result.path[i]);
			}

			const hops = result.path.length - 1;
			return `${a.canonical_name} → ${b.canonical_name} (${hops} hop${hops === 1 ? "" : "s"}):\n\n${segments.join(" ")}`;
		},
	);
}

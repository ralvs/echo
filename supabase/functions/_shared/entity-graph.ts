/**
 * The entity graph — the one place that projects `entities` + `entity_edges`
 * into a node/edge view. It is the read sibling of entities.ts (which owns the
 * write side: extracting mentions and recording co-occurrence on capture) and
 * the structural twin of relation-graph.ts (which ADR-0015 scopes to
 * thought_relations). The co-occurrence graph is an undirected, weighted
 * concept graph that until now was only read piecemeal for an entity's
 * "strongest edges"; this projection hands the whole thing to the pure
 * algorithms in graph-analysis.ts.
 *
 * Like relation-graph.ts, edges with an endpoint outside the node set are
 * dropped (`assemble`) so every downstream traversal stays inside the graph.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeightedGraph } from "./graph-analysis.ts";
import type { EntityType } from "./types.ts";

export type EntityNode = {
	id: string;
	name: string;
	type: EntityType;
	mention_count: number;
};

export type EntityEdge = { source_id: string; target_id: string; weight: number };

export type EntityGraph = { nodes: EntityNode[]; edges: EntityEdge[] };

/** Keep only edges whose endpoints are both present in the node set. */
function assemble(nodes: EntityNode[], edges: EntityEdge[]): EntityGraph {
	const ids = new Set(nodes.map((n) => n.id));
	return { nodes, edges: edges.filter((e) => ids.has(e.source_id) && ids.has(e.target_id)) };
}

/**
 * Reads every entity and every co-occurrence edge into a graph view. `minWeight`
 * drops weak ties (singleton co-occurrences) before assembly — useful for the
 * digest, which wants the salient structure rather than every incidental pair.
 */
export async function entityGraph(
	db: SupabaseClient,
	options: { minWeight?: number } = {},
): Promise<EntityGraph> {
	const minWeight = options.minWeight ?? 1;
	const [{ data: entities }, { data: edges }] = await Promise.all([
		db.from("entities").select("id, type, canonical_name, mention_count"),
		db.from("entity_edges").select("source_id, target_id, weight").gte("weight", minWeight),
	]);

	const nodes: EntityNode[] = (
		(entities ?? []) as {
			id: string;
			type: EntityType;
			canonical_name: string;
			mention_count: number;
		}[]
	).map((e) => ({
		id: e.id,
		name: e.canonical_name,
		type: e.type,
		mention_count: e.mention_count,
	}));

	return assemble(nodes, (edges ?? []) as EntityEdge[]);
}

/** Project an EntityGraph onto the neutral id-only graph the algorithms consume. */
export function toWeightedGraph(graph: EntityGraph): WeightedGraph {
	return {
		nodes: graph.nodes.map((n) => n.id),
		edges: graph.edges.map((e) => ({ source: e.source_id, target: e.target_id, weight: e.weight })),
	};
}

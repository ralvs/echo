/**
 * The relation graph — the one place that projects `thought_relations` into a
 * node/edge view. Both the dashboard graph route (whole corpus + ego graph,
 * rendered as JSON for D3) and the get_thought_context MCP tool (ego graph,
 * rendered as text for the LLM) are formatting adapters over this module, so
 * the traversal — fetch relations, collect neighbours, drop dangling edges —
 * is written and tested once instead of three times.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { NON_BUNDLE_FILTER } from "./thoughts-store.ts";
import type { RelationType, ThoughtMetadata } from "./types.ts";

export type GraphNode = {
	id: string;
	content: string;
	metadata: ThoughtMetadata;
	created_at: string;
	event_at: string | null;
	category: string | null;
};

export type GraphEdge = {
	source_id: string;
	target_id: string;
	relation_type: RelationType;
	confidence: number;
	is_latest: boolean;
};

export type RelationGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

const NODE_COLUMNS = "id, content, metadata, created_at, event_at, category";
const EDGE_COLUMNS = "source_id, target_id, relation_type, confidence, is_latest";

/** A PostgREST `or` filter selecting every relation that touches one of `ids`. */
function touchingFilter(ids: string[]): string {
	return ids.map((id) => `source_id.eq.${id},target_id.eq.${id}`).join(",");
}

function neighboursOf(edges: GraphEdge[], center: string): Set<string> {
	const ids = new Set<string>();
	for (const e of edges) {
		if (e.source_id !== center) ids.add(e.source_id);
		if (e.target_id !== center) ids.add(e.target_id);
	}
	return ids;
}

/** Keep only edges whose endpoints are both present in the node set. */
function assemble(nodes: GraphNode[], edges: GraphEdge[]): RelationGraph {
	const ids = new Set(nodes.map((n) => n.id));
	return { nodes, edges: edges.filter((e) => ids.has(e.source_id) && ids.has(e.target_id)) };
}

/**
 * Projects the relations around one thought into a node/edge graph. Returns
 * `null` if the centre thought doesn't exist. `latestOnly` drops superseded
 * relations (the dashboard view); leaving it false keeps them with their
 * `is_latest` flag so a caller can tag them (the context tool). Depth 2 also
 * pulls in the relations between the centre's neighbours.
 */
export async function egoGraph(
	db: SupabaseClient,
	centerId: string,
	options: { depth?: number; latestOnly?: boolean } = {},
): Promise<RelationGraph | null> {
	const depth = Math.min(Math.max(options.depth ?? 1, 1), 2);
	const latestOnly = options.latestOnly ?? false;

	const { data: center } = await db
		.from("thoughts")
		.select(NODE_COLUMNS)
		.eq("id", centerId)
		.maybeSingle();
	if (!center) return null;

	const fetchEdges = async (ids: string[]): Promise<GraphEdge[]> => {
		let query = db.from("thought_relations").select(EDGE_COLUMNS).or(touchingFilter(ids));
		if (latestOnly) query = query.eq("is_latest", true);
		const { data } = await query;
		return (data ?? []) as GraphEdge[];
	};

	const edges = new Map<string, GraphEdge>();
	const addEdges = (batch: GraphEdge[]) => {
		for (const e of batch) edges.set(`${e.source_id}|${e.target_id}|${e.relation_type}`, e);
	};

	const direct = await fetchEdges([centerId]);
	addEdges(direct);
	const neighbourIds = neighboursOf(direct, centerId);

	if (depth === 2 && neighbourIds.size > 0) {
		const extended = await fetchEdges([...neighbourIds]);
		addEdges(extended);
		for (const id of neighboursOf(extended, centerId)) neighbourIds.add(id);
	}

	const { data: neighbours } =
		neighbourIds.size > 0
			? await db
					.from("thoughts")
					.select(NODE_COLUMNS)
					.in("id", [...neighbourIds])
			: { data: [] as GraphNode[] };

	return assemble(
		[center as GraphNode, ...((neighbours ?? []) as GraphNode[])],
		[...edges.values()],
	);
}

/**
 * Projects the most recent non-bundle thoughts and the latest relations
 * between them into a graph (the dashboard's whole-corpus view).
 */
export async function corpusGraph(
	db: SupabaseClient,
	options: { limit?: number } = {},
): Promise<RelationGraph> {
	const limit = options.limit ?? 300;
	const [{ data: thoughts }, { data: edges }] = await Promise.all([
		db
			.from("thoughts")
			.select(NODE_COLUMNS)
			.or(NON_BUNDLE_FILTER)
			.order("created_at", { ascending: false })
			.limit(limit),
		db.from("thought_relations").select(EDGE_COLUMNS).eq("is_latest", true),
	]);
	return assemble((thoughts ?? []) as GraphNode[], (edges ?? []) as GraphEdge[]);
}

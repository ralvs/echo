import { entityGraph, toWeightedGraph } from "@shared/entity-graph.ts";
import { communities } from "@shared/graph-analysis.ts";
import { corpusGraph, egoGraph, type RelationGraph } from "@shared/relation-graph.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase";

export type GraphNode = {
	id: string;
	label: string;
	type?: string;
	created_at: string;
	/** Community index, present only in entity mode (drives cluster colouring). */
	community?: number;
};

export type GraphLink = {
	source: string;
	target: string;
	relationType: string;
	confidence: number;
};

export type GraphData = {
	nodes: GraphNode[];
	links: GraphLink[];
};

/** Render the shared relation graph as the node/link shape the D3 view expects. */
function toGraphData(graph: RelationGraph): GraphData {
	return {
		nodes: graph.nodes.map((n) => ({
			id: n.id,
			label: n.content.slice(0, 80),
			type: n.metadata?.type,
			created_at: n.created_at,
		})),
		links: graph.edges.map((e) => ({
			source: e.source_id,
			target: e.target_id,
			relationType: e.relation_type,
			confidence: e.confidence,
		})),
	};
}

/**
 * Render the entity co-occurrence graph, coloured by community. Reuses the
 * shared projection + clustering — the route is just the D3-shaped renderer,
 * the dashboard counterpart of the graph_overview MCP tool.
 */
async function entityGraphData(supabase: SupabaseClient): Promise<GraphData> {
	const graph = await entityGraph(supabase);
	const community = communities(toWeightedGraph(graph));

	// Drop unconnected entities: a force layout can't place isolated nodes
	// meaningfully (they scatter off-canvas), and the view is about the
	// co-occurrence structure. Mirrors graph_overview omitting singletons.
	const connected = new Set<string>();
	for (const e of graph.edges) {
		connected.add(e.source_id);
		connected.add(e.target_id);
	}

	return {
		nodes: graph.nodes
			.filter((n) => connected.has(n.id))
			.map((n) => ({
				id: n.id,
				label: n.name,
				type: n.type,
				created_at: "",
				community: community.get(n.id),
			})),
		links: graph.edges.map((e) => ({
			source: e.source_id,
			target: e.target_id,
			relationType: "co_occurs",
			confidence: 1,
		})),
	};
}

export async function GET(req: NextRequest) {
	const auth = await requireOwner();
	if (auth instanceof NextResponse) return auth;
	const supabase = createServiceClient();
	const params = req.nextUrl.searchParams;
	const limit = Number(params.get("limit") || "300");
	const thoughtId = params.get("thoughtId");

	if (params.get("mode") === "entity") {
		return NextResponse.json(await entityGraphData(supabase));
	}

	if (thoughtId) {
		const graph = await egoGraph(supabase, thoughtId, { depth: 1, latestOnly: true });
		if (!graph) return NextResponse.json({ nodes: [], links: [] } satisfies GraphData);
		return NextResponse.json(toGraphData(graph));
	}

	const graph = await corpusGraph(supabase, { limit });
	return NextResponse.json(toGraphData(graph));
}

import { corpusGraph, egoGraph, type RelationGraph } from "@shared/relation-graph.ts";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export type GraphNode = {
	id: string;
	label: string;
	type?: string;
	created_at: string;
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

export async function GET(req: NextRequest) {
	const supabase = createServiceClient();
	const params = req.nextUrl.searchParams;
	const limit = Number(params.get("limit") || "300");
	const thoughtId = params.get("thoughtId");

	if (thoughtId) {
		const graph = await egoGraph(supabase, thoughtId, { depth: 1, latestOnly: true });
		if (!graph) return NextResponse.json({ nodes: [], links: [] } satisfies GraphData);
		return NextResponse.json(toGraphData(graph));
	}

	const graph = await corpusGraph(supabase, { limit });
	return NextResponse.json(toGraphData(graph));
}

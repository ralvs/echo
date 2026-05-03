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

export async function GET(req: NextRequest) {
	const supabase = createServiceClient();
	const params = req.nextUrl.searchParams;
	const limit = Number(params.get("limit") || "300");
	const thoughtId = params.get("thoughtId");

	if (thoughtId) {
		const [centralResult, relationsResult] = await Promise.all([
			supabase
				.from("thoughts")
				.select("id, content, metadata, created_at")
				.eq("id", thoughtId)
				.single(),
			supabase
				.from("thought_relations")
				.select("source_id, target_id, relation_type, confidence")
				.eq("is_latest", true)
				.or(`source_id.eq.${thoughtId},target_id.eq.${thoughtId}`),
		]);

		if (centralResult.error)
			return NextResponse.json({ error: centralResult.error.message }, { status: 500 });
		if (relationsResult.error)
			return NextResponse.json({ error: relationsResult.error.message }, { status: 500 });

		const connectedIds = new Set<string>();
		for (const r of relationsResult.data ?? []) {
			connectedIds.add(r.source_id);
			connectedIds.add(r.target_id);
		}
		connectedIds.delete(thoughtId);

		const connectedResult =
			connectedIds.size > 0
				? await supabase
						.from("thoughts")
						.select("id, content, metadata, created_at")
						.in("id", [...connectedIds])
				: { data: [], error: null };

		if (connectedResult.error)
			return NextResponse.json({ error: connectedResult.error.message }, { status: 500 });

		const allThoughts = [centralResult.data, ...(connectedResult.data ?? [])];
		const thoughtIds = new Set(allThoughts.map((t) => t.id));

		return NextResponse.json({
			nodes: allThoughts.map((t) => ({
				id: t.id,
				label: t.content.slice(0, 80),
				type: t.metadata?.type,
				created_at: t.created_at,
			})),
			links: (relationsResult.data ?? [])
				.filter((r) => thoughtIds.has(r.source_id) && thoughtIds.has(r.target_id))
				.map((r) => ({
					source: r.source_id,
					target: r.target_id,
					relationType: r.relation_type,
					confidence: r.confidence,
				})),
		} satisfies GraphData);
	}

	const [thoughtsResult, relationsResult] = await Promise.all([
		supabase
			.from("thoughts")
			.select("id, content, metadata, created_at")
			.or("is_bundle.is.null,is_bundle.eq.false")
			.order("created_at", { ascending: false })
			.limit(limit),
		supabase
			.from("thought_relations")
			.select("source_id, target_id, relation_type, confidence")
			.eq("is_latest", true),
	]);

	if (thoughtsResult.error)
		return NextResponse.json({ error: thoughtsResult.error.message }, { status: 500 });
	if (relationsResult.error)
		return NextResponse.json({ error: relationsResult.error.message }, { status: 500 });

	const thoughtIds = new Set(thoughtsResult.data.map((t) => t.id));

	return NextResponse.json({
		nodes: thoughtsResult.data.map((t) => ({
			id: t.id,
			label: t.content.slice(0, 80),
			type: t.metadata?.type,
			created_at: t.created_at,
		})),
		links: (relationsResult.data ?? [])
			.filter((r) => thoughtIds.has(r.source_id) && thoughtIds.has(r.target_id))
			.map((r) => ({
				source: r.source_id,
				target: r.target_id,
				relationType: r.relation_type,
				confidence: r.confidence,
			})),
	} satisfies GraphData);
}

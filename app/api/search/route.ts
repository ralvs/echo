import { embed } from "ai";
import { type NextRequest, NextResponse } from "next/server";
import { applyDecay } from "@/lib/search-assembly";

export async function POST(req: NextRequest) {
	const body = await req.json();
	const { query, limit = 10, threshold = 0.5 } = body;

	if (!query) {
		return NextResponse.json({ error: "query is required" }, { status: 400 });
	}

	const { embedding } = await embed({
		model: "openai/text-embedding-3-small",
		value: query,
	});

	if (!embedding) {
		return NextResponse.json({ error: "Failed to generate embedding" }, { status: 500 });
	}

	const { createServiceClient } = await import("@/lib/supabase");
	const supabase = createServiceClient();

	const { data, error } = await supabase.rpc("hybrid_search", {
		query_text: query,
		query_embedding: embedding,
		match_threshold: threshold,
		match_count: limit,
		alpha: 0.7,
		filter: {},
	});

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	const filtered = (data || []).filter((t: { is_bundle?: boolean }) => !t.is_bundle);

	return NextResponse.json(applyDecay(filtered));
}

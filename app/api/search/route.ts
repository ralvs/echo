import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
	const body = await req.json();
	const { query, limit = 10, threshold = 0.5 } = body;

	if (!query) {
		return NextResponse.json({ error: "query is required" }, { status: 400 });
	}

	// Generate embedding via OpenRouter
	const embRes = await fetch("https://openrouter.ai/api/v1/embeddings", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "openai/text-embedding-3-small",
			input: query,
		}),
	});

	const embData = await embRes.json();
	const embedding = embData.data?.[0]?.embedding;

	if (!embedding) {
		return NextResponse.json({ error: "Failed to generate embedding" }, { status: 500 });
	}

	// Use Supabase service client for RPC
	const { createServiceClient } = await import("@/lib/supabase");
	const supabase = createServiceClient();

	const { data, error } = await supabase.rpc("match_thoughts", {
		query_embedding: embedding,
		match_threshold: threshold,
		match_count: limit,
		filter: {},
	});

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	return NextResponse.json(data || []);
}

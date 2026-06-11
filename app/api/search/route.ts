import { searchThoughts } from "@shared/search.ts";
import { type NextRequest, NextResponse } from "next/server";
import { nodeAi } from "@/lib/model";

export async function POST(req: NextRequest) {
	const body = await req.json();
	const { query, limit = 10, threshold } = body;

	if (!query) {
		return NextResponse.json({ error: "query is required" }, { status: 400 });
	}

	const { createServiceClient } = await import("@/lib/supabase");

	try {
		const response = await searchThoughts({ db: createServiceClient(), ai: nodeAi }, query, {
			limit,
			threshold,
		});
		return NextResponse.json(response);
	} catch (err: unknown) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

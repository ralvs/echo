import { getThoughtStats } from "@shared/stats.ts";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET() {
	try {
		const stats = await getThoughtStats(createServiceClient());
		return NextResponse.json(stats);
	} catch (err) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

import { getThoughtStats } from "@shared/stats.ts";
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase";

export async function GET() {
	const auth = await requireOwner();
	if (auth instanceof NextResponse) return auth;
	try {
		const stats = await getThoughtStats(createServiceClient());
		return NextResponse.json(stats);
	} catch (err) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

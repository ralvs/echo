import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET() {
	const supabase = createServiceClient();
	const { data, error } = await supabase.rpc("get_thought_stats");
	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json(data);
}

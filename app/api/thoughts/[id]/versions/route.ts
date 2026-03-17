import { createServiceClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const supabase = createServiceClient();

	const { data, error } = await supabase
		.from("thought_versions")
		.select("id, thought_id, version, content, metadata, created_at, archived_at")
		.eq("thought_id", id)
		.order("version", { ascending: false });

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json(data);
}

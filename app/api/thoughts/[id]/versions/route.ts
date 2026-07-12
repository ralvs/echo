import { type NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const auth = await requireOwner();
	if (auth instanceof NextResponse) return auth;
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

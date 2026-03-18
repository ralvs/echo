import { createServiceClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const supabase = createServiceClient();
	const body = await req.json();
	const status = body.status === "open" ? "open" : "resolved";

	const { data: current, error: fetchErr } = await supabase
		.from("thoughts")
		.select("id, metadata")
		.eq("id", id)
		.single();

	if (fetchErr || !current) {
		return NextResponse.json({ error: "Thought not found" }, { status: 404 });
	}

	const metadata = {
		...current.metadata,
		status,
		...(status === "resolved" ? { resolved_at: new Date().toISOString() } : { resolved_at: null }),
	};

	const { data, error } = await supabase
		.from("thoughts")
		.update({ metadata, updated_at: new Date().toISOString() })
		.eq("id", id)
		.select("id, content, metadata, version, created_at, updated_at")
		.single();

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json(data);
}

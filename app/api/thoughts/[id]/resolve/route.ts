import { resolveThought } from "@shared/resolve.ts";
import { type NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const auth = await requireOwner();
	if (auth instanceof NextResponse) return auth;
	const { id } = await params;
	const body = await req.json();
	const status = body.status === "open" ? "open" : "resolved";

	try {
		const result = await resolveThought(createServiceClient(), id, status);
		if (result.kind === "not_found") {
			return NextResponse.json({ error: "Thought not found" }, { status: 404 });
		}
		return NextResponse.json(result.thought);
	} catch (err) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

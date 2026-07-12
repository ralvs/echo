import { after, type NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase";
import { updateThought } from "@/lib/update";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const auth = await requireOwner();
	if (auth instanceof NextResponse) return auth;
	const { id } = await params;
	const supabase = createServiceClient();

	const { data, error } = await supabase
		.from("thoughts")
		.select(
			"id, content, metadata, version, due_at, recurrence, priority, category, created_at, updated_at",
		)
		.eq("id", id)
		.single();

	if (error) return NextResponse.json({ error: error.message }, { status: 404 });
	return NextResponse.json(data);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const auth = await requireOwner();
	if (auth instanceof NextResponse) return auth;
	const { id } = await params;
	const body = await req.json();

	try {
		const result = await updateThought(
			id,
			{
				content: typeof body.content === "string" ? body.content : undefined,
				metadata: body.metadata,
				due_at: body.due_at,
				recurrence: body.recurrence,
				priority: body.priority,
				category: body.category,
			},
			// Compounding side effects (topic pages, entity graph) outlive the response.
			(work) => after(work),
		);

		if (result.kind === "not_found") {
			return NextResponse.json({ error: "Thought not found" }, { status: 404 });
		}
		return NextResponse.json(result.thought);
	} catch (err) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const auth = await requireOwner();
	if (auth instanceof NextResponse) return auth;
	const { id } = await params;
	const supabase = createServiceClient();

	const { error } = await supabase.from("thoughts").delete().eq("id", id);

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json({ deleted: true });
}

import { createServiceClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const supabase = createServiceClient();

	const { data, error } = await supabase
		.from("thoughts")
		.select("id, content, metadata, version, due_at, recurrence, priority, category, created_at, updated_at")
		.eq("id", id)
		.single();

	if (error) return NextResponse.json({ error: error.message }, { status: 404 });
	return NextResponse.json(data);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const supabase = createServiceClient();
	const body = await req.json();

	// Archive current version first
	const { data: current, error: fetchErr } = await supabase
		.from("thoughts")
		.select("id, content, embedding, metadata, version, created_at")
		.eq("id", id)
		.single();

	if (fetchErr || !current) {
		return NextResponse.json({ error: "Thought not found" }, { status: 404 });
	}

	await supabase.from("thought_versions").insert({
		thought_id: current.id,
		version: current.version,
		content: current.content,
		embedding: current.embedding,
		metadata: current.metadata,
		created_at: current.created_at,
	});

	const newVersion = (current.version || 1) + 1;

	const updateRow: Record<string, unknown> = {
		content: body.content,
		metadata: body.metadata || current.metadata,
		version: newVersion,
		updated_at: new Date().toISOString(),
	};
	if (body.due_at !== undefined) updateRow.due_at = body.due_at;
	if (body.recurrence !== undefined) updateRow.recurrence = body.recurrence;
	if (body.priority !== undefined) updateRow.priority = body.priority;
	if (body.category !== undefined) updateRow.category = body.category;

	const { data, error } = await supabase
		.from("thoughts")
		.update(updateRow)
		.eq("id", id)
		.select("id, content, metadata, version, due_at, recurrence, priority, category, created_at, updated_at")
		.single();

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const supabase = createServiceClient();

	const { error } = await supabase.from("thoughts").delete().eq("id", id);

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json({ deleted: true });
}

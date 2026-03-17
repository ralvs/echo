import { createServiceClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
	const supabase = createServiceClient();
	const params = req.nextUrl.searchParams;

	const limit = Number(params.get("limit") || "50");
	const type = params.get("type");
	const topic = params.get("topic");
	const person = params.get("person");
	const days = params.get("days");

	let query = supabase
		.from("thoughts")
		.select("id, content, metadata, version, created_at, updated_at")
		.order("created_at", { ascending: false })
		.limit(limit);

	if (type) query = query.contains("metadata", { type });
	if (topic) query = query.contains("metadata", { topics: [topic] });
	if (person) query = query.contains("metadata", { people: [person] });
	if (days) {
		const since = new Date();
		since.setDate(since.getDate() - Number(days));
		query = query.gte("created_at", since.toISOString());
	}

	const { data, error } = await query;

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
	const supabase = createServiceClient();
	const body = await req.json();

	const { data, error } = await supabase
		.from("thoughts")
		.insert({
			content: body.content,
			metadata: body.metadata || {},
		})
		.select("id, content, metadata, version, created_at, updated_at")
		.single();

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json(data, { status: 201 });
}

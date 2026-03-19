import { createServiceClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

const THOUGHT_COLUMNS = "id, content, metadata, version, due_at, recurrence, priority, category, created_at, updated_at";

export async function GET(req: NextRequest) {
	const supabase = createServiceClient();
	const params = req.nextUrl.searchParams;

	const limit = Number(params.get("limit") || "50");
	const type = params.get("type");
	const topic = params.get("topic");
	const person = params.get("person");
	const days = params.get("days");
	const status = params.get("status");
	const category = params.get("category");
	const priority = params.get("priority");
	const overdue = params.get("overdue");
	const dueWithinDays = params.get("due_within_days");
	const orderBy = params.get("order_by");

	let query = supabase
		.from("thoughts")
		.select(THOUGHT_COLUMNS)
		.limit(limit);

	// Sorting
	if (orderBy === "due_at") {
		query = query.order("due_at", { ascending: true, nullsFirst: false });
	} else if (orderBy === "priority") {
		query = query.order("priority", { ascending: false, nullsFirst: false });
	} else {
		query = query.order("created_at", { ascending: false });
	}

	// JSONB filters
	if (type) query = query.contains("metadata", { type });
	if (topic) query = query.contains("metadata", { topics: [topic] });
	if (person) query = query.contains("metadata", { people: [person] });
	if (status) query = query.contains("metadata", { status });

	// Column filters
	if (category) query = query.eq("category", category);
	if (priority) query = query.gte("priority", Number(priority));

	if (days) {
		const since = new Date();
		since.setDate(since.getDate() - Number(days));
		query = query.gte("created_at", since.toISOString());
	}

	const now = new Date().toISOString();
	if (overdue === "true") {
		query = query.lt("due_at", now).contains("metadata", { status: "open" });
	}
	if (dueWithinDays) {
		const until = new Date();
		until.setDate(until.getDate() + Number(dueWithinDays));
		query = query.gte("due_at", now).lte("due_at", until.toISOString());
	}

	const { data, error } = await query;

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
	const supabase = createServiceClient();
	const body = await req.json();

	const row: Record<string, unknown> = {
		content: body.content,
		metadata: body.metadata || {},
	};
	if (body.due_at) row.due_at = body.due_at;
	if (body.recurrence) row.recurrence = body.recurrence;
	if (body.priority !== undefined) row.priority = body.priority;
	if (body.category) row.category = body.category;

	const { data, error } = await supabase
		.from("thoughts")
		.insert(row)
		.select(THOUGHT_COLUMNS)
		.single();

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json(data, { status: 201 });
}

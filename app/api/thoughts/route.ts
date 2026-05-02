import { type NextRequest, NextResponse } from "next/server";
import { extractMetadata, getEmbedding } from "@/lib/ai";
import { createServiceClient } from "@/lib/supabase";

const THOUGHT_COLUMNS =
	"id, content, metadata, version, due_at, recurrence, priority, category, source_id, source_kind, created_at, updated_at";

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
		.or("is_bundle.is.null,is_bundle.eq.false")
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

	const text = body.content;
	if (!text?.trim()) {
		return NextResponse.json({ error: "Content is required" }, { status: 400 });
	}

	const sourceId = typeof body.source_id === "string" ? body.source_id : null;
	const sourceKind = typeof body.source_kind === "string" ? body.source_kind : null;

	// Idempotency check — if a row with this source_id already exists, short-circuit.
	if (sourceId) {
		const { data: existing } = await supabase
			.from("thoughts")
			.select("id")
			.eq("source_id", sourceId)
			.maybeSingle();
		if (existing) {
			return NextResponse.json(
				{ skipped: "duplicate", id: existing.id, source_id: sourceId },
				{ status: 200 },
			);
		}
	}

	// Run AI processing in parallel: embedding + metadata extraction
	const [embedding, extracted] = await Promise.all([getEmbedding(text), extractMetadata(text)]);

	// Destructure column fields from metadata fields — no manual delete needed
	const {
		category: extractedCategory,
		due_at: extractedDueAt,
		recurrence: extractedRecurrence,
		priority: extractedPriority,
		expires_at: extractedExpiresAt,
		event_at: extractedEventAt,
		...jsonbFields
	} = extracted;

	// Build metadata — caller overrides take precedence over extracted values
	const metadata: Record<string, unknown> = { ...jsonbFields, source: "echo" };
	if (body.metadata?.type) metadata.type = body.metadata.type;
	if (body.metadata?.topics) metadata.topics = body.metadata.topics;
	if (body.metadata?.memory_type) metadata.memory_type = body.metadata.memory_type;

	// Auto-set status for actionable thoughts
	const effectiveType = metadata.type as string;
	const effectiveDueAt = body.due_at || extractedDueAt;
	if (
		effectiveType === "task" ||
		effectiveDueAt ||
		(Array.isArray(metadata.action_items) && metadata.action_items.length > 0)
	) {
		metadata.status = "open";
	}

	const row: Record<string, unknown> = {
		content: text,
		embedding,
		metadata,
	};

	// Real columns — caller overrides > extracted values
	if (body.due_at || extractedDueAt) row.due_at = body.due_at || extractedDueAt;
	if (body.recurrence || extractedRecurrence)
		row.recurrence = body.recurrence || extractedRecurrence;
	if (body.priority !== undefined) {
		row.priority = body.priority;
	} else if (extractedPriority && extractedPriority > 0) {
		row.priority = extractedPriority;
	}
	row.category = body.category || extractedCategory || null;

	if (sourceId) row.source_id = sourceId;
	if (sourceKind) row.source_kind = sourceKind;
	if (typeof body.expires_at === "string") row.expires_at = body.expires_at;
	if (extractedExpiresAt && !body.expires_at) row.expires_at = extractedExpiresAt;
	if (extractedEventAt) row.event_at = extractedEventAt;

	const { data, error } = await supabase
		.from("thoughts")
		.insert(row)
		.select(THOUGHT_COLUMNS)
		.single();

	if (error) {
		// Postgres unique-violation code — race between idempotency check and insert.
		if (error.code === "23505" && sourceId) {
			const { data: existing } = await supabase
				.from("thoughts")
				.select("id")
				.eq("source_id", sourceId)
				.maybeSingle();
			return NextResponse.json(
				{ skipped: "duplicate", id: existing?.id ?? null, source_id: sourceId },
				{ status: 200 },
			);
		}
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	return NextResponse.json(data, { status: 201 });
}

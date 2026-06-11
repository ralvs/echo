import { listThoughts, type ThoughtListFilters } from "@shared/list-thoughts.ts";
import { after, type NextRequest, NextResponse } from "next/server";
import { captureThought } from "@/lib/capture";
import { createServiceClient } from "@/lib/supabase";

const THOUGHT_COLUMNS =
	"id, content, metadata, version, due_at, recurrence, priority, category, source_id, source_kind, created_at, updated_at";

export async function GET(req: NextRequest) {
	const supabase = createServiceClient();
	const params = req.nextUrl.searchParams;

	const num = (name: string) => {
		const v = params.get(name);
		return v ? Number(v) : undefined;
	};
	const orderBy = params.get("order_by");

	const filters: ThoughtListFilters = {
		limit: num("limit") ?? 50,
		type: params.get("type") ?? undefined,
		topic: params.get("topic") ?? undefined,
		person: params.get("person") ?? undefined,
		status: params.get("status") ?? undefined,
		category: params.get("category") ?? undefined,
		minPriority: num("priority"),
		days: num("days"),
		overdue: params.get("overdue") === "true",
		dueWithinDays: num("due_within_days"),
		orderBy:
			orderBy === "due_at" || orderBy === "priority" || orderBy === "created_at"
				? orderBy
				: undefined,
	};

	try {
		const data = await listThoughts(supabase, filters, THOUGHT_COLUMNS);
		return NextResponse.json(data);
	} catch (err) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

export async function POST(req: NextRequest) {
	const body = await req.json();

	if (!body.content?.trim()) {
		return NextResponse.json({ error: "Content is required" }, { status: 400 });
	}

	try {
		const result = await captureThought(
			{
				content: body.content,
				type: typeof body.metadata?.type === "string" ? body.metadata.type : undefined,
				topics: Array.isArray(body.metadata?.topics) ? body.metadata.topics : undefined,
				memory_type:
					typeof body.metadata?.memory_type === "string" ? body.metadata.memory_type : undefined,
				source_id: typeof body.source_id === "string" ? body.source_id : null,
				source_kind: typeof body.source_kind === "string" ? body.source_kind : null,
				due_at: body.due_at ?? null,
				recurrence: body.recurrence ?? null,
				priority: body.priority,
				category: body.category ?? null,
				expires_at: typeof body.expires_at === "string" ? body.expires_at : null,
			},
			// Compounding side effects (topic pages, entity graph) outlive the response.
			(work) => after(work),
		);

		if (result.kind === "duplicate") {
			return NextResponse.json(
				{ skipped: "duplicate", id: result.id, source_id: result.source_id },
				{ status: 200 },
			);
		}
		if (result.kind === "decomposed") {
			return NextResponse.json({ ...result.parent, children: result.children }, { status: 201 });
		}
		return NextResponse.json(result.thought, { status: 201 });
	} catch (err) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}

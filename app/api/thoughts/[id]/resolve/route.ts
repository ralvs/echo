import { createServiceClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

type RecurrenceRule = {
	interval_days?: number;
	unit?: "day" | "week" | "month";
	days_of_week?: number[];
	day_of_month?: number;
	end_at?: string;
};

function calculateNextDue(currentDue: Date, rule: RecurrenceRule): Date {
	const now = new Date();
	const next = new Date(Math.max(currentDue.getTime(), now.getTime()));

	if (rule.unit === "month") {
		next.setMonth(next.getMonth() + (rule.interval_days || 1));
		if (rule.day_of_month) next.setDate(rule.day_of_month);
	} else {
		next.setDate(next.getDate() + (rule.interval_days || 1));
	}

	if (rule.days_of_week?.length) {
		const isoDay = (d: Date) => d.getDay() || 7;
		while (!rule.days_of_week.includes(isoDay(next))) {
			next.setDate(next.getDate() + 1);
		}
	}

	return next;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const supabase = createServiceClient();
	const body = await req.json();
	const status = body.status === "open" ? "open" : "resolved";

	const { data: current, error: fetchErr } = await supabase
		.from("thoughts")
		.select("id, content, embedding, metadata, version, created_at, due_at, recurrence")
		.eq("id", id)
		.single();

	if (fetchErr || !current) {
		return NextResponse.json({ error: "Thought not found" }, { status: 404 });
	}

	const currentMetadata = current.metadata as Record<string, unknown>;

	// Recurring thought: resolve-and-advance
	if (status === "resolved" && current.recurrence) {
		const rule = current.recurrence as RecurrenceRule;

		// Check if recurrence has ended
		if (rule.end_at && new Date(rule.end_at) < new Date()) {
			const metadata = {
				...currentMetadata,
				status: "resolved",
				resolved_at: new Date().toISOString(),
			};

			const { data, error } = await supabase
				.from("thoughts")
				.update({ metadata, updated_at: new Date().toISOString() })
				.eq("id", id)
				.select("id, content, metadata, version, due_at, recurrence, priority, category, created_at, updated_at")
				.single();

			if (error) return NextResponse.json({ error: error.message }, { status: 500 });
			return NextResponse.json(data);
		}

		// Archive current version
		await supabase.from("thought_versions").insert({
			thought_id: current.id,
			version: current.version,
			content: current.content,
			embedding: current.embedding,
			metadata: current.metadata,
			created_at: current.created_at,
			archived_at: new Date().toISOString(),
		});

		// Calculate next due
		const currentDue = current.due_at ? new Date(current.due_at) : new Date();
		const nextDue = calculateNextDue(currentDue, rule);

		const completionCount = ((currentMetadata.completion_count as number) || 0) + 1;
		const metadata = {
			...currentMetadata,
			status: "open",
			resolved_at: null,
			last_completed: new Date().toISOString(),
			completion_count: completionCount,
		};

		const newVersion = (current.version || 1) + 1;
		const { data, error } = await supabase
			.from("thoughts")
			.update({
				metadata,
				due_at: nextDue.toISOString(),
				version: newVersion,
				updated_at: new Date().toISOString(),
			})
			.eq("id", id)
			.select("id, content, metadata, version, due_at, recurrence, priority, category, created_at, updated_at")
			.single();

		if (error) return NextResponse.json({ error: error.message }, { status: 500 });
		return NextResponse.json(data);
	}

	// Non-recurring: simple status toggle
	const metadata = {
		...currentMetadata,
		status,
		...(status === "resolved" ? { resolved_at: new Date().toISOString() } : { resolved_at: null }),
	};

	const { data, error } = await supabase
		.from("thoughts")
		.update({ metadata, updated_at: new Date().toISOString() })
		.eq("id", id)
		.select("id, content, metadata, version, due_at, recurrence, priority, category, created_at, updated_at")
		.single();

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json(data);
}

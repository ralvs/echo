import { createServiceClient } from "@/lib/supabase";
import { NextResponse } from "next/server";

export async function GET() {
	const supabase = createServiceClient();

	const { count } = await supabase
		.from("thoughts")
		.select("*", { count: "exact", head: true })
		.or("is_bundle.is.null,is_bundle.eq.false");

	const { data } = await supabase
		.from("thoughts")
		.select("metadata, created_at, category, priority, due_at, recurrence")
		.or("is_bundle.is.null,is_bundle.eq.false")
		.order("created_at", { ascending: false });

	const types: Record<string, number> = {};
	const topics: Record<string, number> = {};
	const people: Record<string, number> = {};
	const categories: Record<string, number> = {};
	let overdueCount = 0;
	let recurringCount = 0;
	const now = new Date();

	for (const r of data || []) {
		const m = (r.metadata || {}) as Record<string, unknown>;
		if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
		if (Array.isArray(m.topics))
			for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
		if (Array.isArray(m.people))
			for (const p of m.people) {
				const name = typeof p === "string" ? p : (p as Record<string, unknown>)?.name;
				if (typeof name === "string" && name) people[name] = (people[name] || 0) + 1;
			}
		if (r.category) categories[r.category] = (categories[r.category] || 0) + 1;
		if (r.recurrence) recurringCount++;
		if (r.due_at && new Date(r.due_at) < now && m.status === "open") overdueCount++;
	}

	const dateRange =
		data?.length
			? { from: data[data.length - 1].created_at, to: data[0].created_at }
			: null;

	return NextResponse.json({
		total: count || 0,
		dateRange,
		types,
		topics,
		people,
		categories,
		overdueCount,
		recurringCount,
	});
}

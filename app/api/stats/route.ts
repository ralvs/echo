import { createServiceClient } from "@/lib/supabase";
import { NextResponse } from "next/server";

export async function GET() {
	const supabase = createServiceClient();

	const { count } = await supabase
		.from("thoughts")
		.select("*", { count: "exact", head: true });

	const { data } = await supabase
		.from("thoughts")
		.select("metadata, created_at")
		.order("created_at", { ascending: false });

	const types: Record<string, number> = {};
	const topics: Record<string, number> = {};
	const people: Record<string, number> = {};

	for (const r of data || []) {
		const m = (r.metadata || {}) as Record<string, unknown>;
		if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
		if (Array.isArray(m.topics))
			for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
		if (Array.isArray(m.people))
			for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
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
	});
}

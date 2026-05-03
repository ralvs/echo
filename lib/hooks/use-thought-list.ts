"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { useThoughtsStore } from "@/lib/store";
import type { ThoughtFilters } from "@/lib/types";

function searchParamsToFilters(params: URLSearchParams): ThoughtFilters {
	return {
		type: params.get("type") ?? undefined,
		topic: params.get("topic") ?? undefined,
		person: params.get("person") ?? undefined,
		days: params.get("days") ? Number(params.get("days")) : undefined,
		status: (params.get("status") as ThoughtFilters["status"]) ?? undefined,
		category: params.get("category") ?? undefined,
		priority: params.get("priority") ? Number(params.get("priority")) : undefined,
		overdue: params.get("overdue") === "true" ? true : undefined,
		order_by: (params.get("order_by") as ThoughtFilters["order_by"]) ?? undefined,
	};
}

function filtersToSearchParams(filters: ThoughtFilters): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.type) params.set("type", filters.type);
	if (filters.topic) params.set("topic", filters.topic);
	if (filters.person) params.set("person", filters.person);
	if (filters.days) params.set("days", String(filters.days));
	if (filters.status) params.set("status", filters.status);
	if (filters.category) params.set("category", filters.category);
	if (filters.priority) params.set("priority", String(filters.priority));
	if (filters.overdue) params.set("overdue", "true");
	if (filters.order_by) params.set("order_by", filters.order_by);
	return params;
}

export function useThoughtList() {
	const thoughts = useThoughtsStore((s) => s.thoughts);
	const setThoughts = useThoughtsStore((s) => s.setThoughts);
	const isLoading = useThoughtsStore((s) => s.isLoading);
	const setIsLoading = useThoughtsStore((s) => s.setIsLoading);
	const searchParams = useSearchParams();
	const router = useRouter();

	const filters = searchParamsToFilters(searchParams);

	const setFilters = useCallback(
		(newFilters: ThoughtFilters) => {
			const params = filtersToSearchParams(newFilters);
			const qs = params.toString();
			router.replace(qs ? `/thoughts?${qs}` : "/thoughts", { scroll: false });
		},
		[router],
	);

	const refresh = useCallback(async () => {
		setIsLoading(true);
		const params = new URLSearchParams({ limit: "100" });
		searchParams.forEach((v, k) => {
			if (k !== "limit") params.set(k, v);
		});

		try {
			const res = await fetch(`/api/thoughts?${params}`);
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			setThoughts(Array.isArray(data) ? data : []);
		} catch {
			setThoughts([]);
		} finally {
			setIsLoading(false);
		}
	}, [searchParams, setThoughts, setIsLoading]);

	return {
		thoughts,
		isLoading,
		filters,
		setFilters,
		refresh,
	};
}

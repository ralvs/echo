"use client";

import { useCallback } from "react";
import { useThoughtsStore } from "@/lib/store";
import type { ThoughtFilters } from "@/lib/types";

export function useThoughtList() {
	const thoughts = useThoughtsStore((s) => s.thoughts);
	const setThoughts = useThoughtsStore((s) => s.setThoughts);
	const isLoading = useThoughtsStore((s) => s.isLoading);
	const setIsLoading = useThoughtsStore((s) => s.setIsLoading);
	const filters = useThoughtsStore((s) => s.filters);
	const setFilters = useThoughtsStore((s) => s.setFilters);

	const refresh = useCallback(async () => {
		setIsLoading(true);
		const params = new URLSearchParams({ limit: "100" });
		if (filters.type) params.set("type", filters.type);
		if (filters.topic) params.set("topic", filters.topic);
		if (filters.person) params.set("person", filters.person);
		if (filters.days) params.set("days", String(filters.days));
		if (filters.status) params.set("status", filters.status);
		if (filters.category) params.set("category", filters.category);
		if (filters.priority) params.set("priority", String(filters.priority));
		if (filters.overdue) params.set("overdue", "true");
		if (filters.order_by) params.set("order_by", filters.order_by);

		try {
			const res = await fetch(`/api/thoughts?${params}`);
			const data = await res.json();
			setThoughts(Array.isArray(data) ? data : []);
		} catch {
			setThoughts([]);
		} finally {
			setIsLoading(false);
		}
	}, [filters, setThoughts, setIsLoading]);

	return { thoughts, isLoading, filters, setFilters: setFilters as (f: ThoughtFilters) => void, refresh };
}

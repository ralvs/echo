"use client";

import { useState } from "react";
import { useThoughtsStore } from "@/lib/store";
import type { Thought } from "@/lib/types";

export type SearchResult = Thought & { similarity: number };

export function useSearch() {
	const searchQuery = useThoughtsStore((s) => s.searchQuery);
	const setSearchQuery = useThoughtsStore((s) => s.setSearchQuery);
	const [results, setResults] = useState<SearchResult[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	async function search(query = searchQuery) {
		if (!query.trim()) {
			setResults([]);
			setError(null);
			return;
		}
		setIsSearching(true);
		setError(null);
		try {
			const res = await fetch("/api/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query, limit: 30 }),
			});
			const data = await res.json();
			if (!res.ok) {
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			setResults(Array.isArray(data) ? data : []);
		} catch (err) {
			setError(err instanceof Error ? err : new Error(String(err)));
			setResults([]);
		} finally {
			setIsSearching(false);
		}
	}

	function clearSearch() {
		setSearchQuery("");
		setResults([]);
		setError(null);
	}

	return {
		query: searchQuery,
		setQuery: setSearchQuery,
		results,
		isSearching,
		error,
		search,
		clearSearch,
	};
}

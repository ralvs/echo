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

	async function search(query = searchQuery) {
		if (!query.trim()) {
			setResults([]);
			return;
		}
		setIsSearching(true);
		try {
			const data = await fetch("/api/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query, limit: 30 }),
			}).then((r) => r.json());
			setResults(Array.isArray(data) ? data : []);
		} catch {
			setResults([]);
		} finally {
			setIsSearching(false);
		}
	}

	function clearSearch() {
		setSearchQuery("");
		setResults([]);
	}

	return {
		query: searchQuery,
		setQuery: setSearchQuery,
		results,
		isSearching,
		search,
		clearSearch,
	};
}

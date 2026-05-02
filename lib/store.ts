"use client";

import { create } from "zustand";
import type { Thought, ThoughtFilters, ThoughtStats } from "./types";

type ThoughtsState = {
	thoughts: Thought[];
	selectedThought: Thought | null;
	stats: ThoughtStats | null;
	searchQuery: string;
	filters: ThoughtFilters;
	isLoading: boolean;

	setThoughts: (thoughts: Thought[]) => void;
	setSelectedThought: (thought: Thought | null) => void;
	setStats: (stats: ThoughtStats) => void;
	setSearchQuery: (query: string) => void;
	setFilters: (filters: ThoughtFilters) => void;
	setIsLoading: (loading: boolean) => void;
};

export const useThoughtsStore = create<ThoughtsState>((set) => ({
	thoughts: [],
	selectedThought: null,
	stats: null,
	searchQuery: "",
	filters: {},
	isLoading: false,

	setThoughts: (thoughts) => set({ thoughts }),
	setSelectedThought: (selectedThought) => set({ selectedThought }),
	setStats: (stats) => set({ stats }),
	setSearchQuery: (searchQuery) => set({ searchQuery }),
	setFilters: (filters) => set({ filters }),
	setIsLoading: (isLoading) => set({ isLoading }),
}));

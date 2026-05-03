"use client";

import { create } from "zustand";
import type { Thought, ThoughtStats } from "./types";

type ThoughtsState = {
	thoughts: Thought[];
	selectedThought: Thought | null;
	stats: ThoughtStats | null;
	searchQuery: string;
	isLoading: boolean;

	setThoughts: (thoughts: Thought[]) => void;
	setSelectedThought: (thought: Thought | null) => void;
	setStats: (stats: ThoughtStats) => void;
	setSearchQuery: (query: string) => void;
	setIsLoading: (loading: boolean) => void;
};

export const useThoughtsStore = create<ThoughtsState>((set) => ({
	thoughts: [],
	selectedThought: null,
	stats: null,
	searchQuery: "",
	isLoading: false,

	setThoughts: (thoughts) => set({ thoughts }),
	setSelectedThought: (selectedThought) => set({ selectedThought }),
	setStats: (stats) => set({ stats }),
	setSearchQuery: (searchQuery) => set({ searchQuery }),
	setIsLoading: (isLoading) => set({ isLoading }),
}));

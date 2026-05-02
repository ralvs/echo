const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

type SearchResult = {
	similarity: number;
	created_at: string;
	metadata: Record<string, unknown>;
	[key: string]: unknown;
};

/**
 * Applies memory-type-aware decay to search result similarity scores.
 * Facts and procedural knowledge don't decay; episodic memories decay fastest.
 * Used in both the REST API and the MCP tool so ranking is consistent.
 */
export function applyDecay<T extends SearchResult>(results: T[]): T[] {
	const now = Date.now();
	return results
		.map((t) => {
			const ageMonths = (now - new Date(t.created_at).getTime()) / MONTH_MS;
			const memType = (t.metadata?.memory_type as string | undefined) ?? "episodic";
			const decay =
				memType === "fact" || memType === "procedural"
					? 1.0
					: memType === "preference"
						? Math.max(0.7, 1 - ageMonths * 0.02)
						: Math.max(0.5, 1 - ageMonths * 0.05); // episodic
			return { ...t, similarity: t.similarity * decay };
		})
		.sort((a, b) => b.similarity - a.similarity);
}

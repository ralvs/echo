import { embed } from "ai";

// Changing EMBEDDING_MODEL invalidates all stored vectors — run a re-indexing
// migration (backfill `embedding` column) before swapping models in production.
export const EMBEDDING_MODEL =
	process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

export async function getEmbedding(text: string): Promise<number[]> {
	const { embedding } = await embed({ model: EMBEDDING_MODEL, value: text });
	return embedding;
}

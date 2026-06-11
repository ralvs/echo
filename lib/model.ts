/**
 * Node adapter at the model-call seam: Vercel AI SDK via the AI Gateway.
 * The Deno edge function satisfies the same interface with raw fetch
 * (supabase/functions/echo-mcp/model.ts).
 */

import type { Ai, ModelRequest } from "@shared/model.ts";
import { embed, generateText } from "ai";

// Changing EMBEDDING_MODEL invalidates all stored vectors — run a re-indexing
// migration (backfill `embedding` column) before swapping models in production.
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
const CHAT_MODEL = "anthropic/claude-haiku-4-5";

export const nodeAi: Ai = {
	async generate(req: ModelRequest): Promise<string> {
		const { text } = await generateText({
			model: CHAT_MODEL,
			maxOutputTokens: req.maxOutputTokens,
			messages: [
				{ role: "system", content: req.system },
				{ role: "user", content: req.prompt },
			],
		});
		return text;
	},

	async embed(text: string): Promise<number[]> {
		const { embedding } = await embed({ model: EMBEDDING_MODEL, value: text });
		return embedding;
	},
};

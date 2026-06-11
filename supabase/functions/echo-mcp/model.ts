/**
 * Deno adapter at the model-call seam: raw fetch to the Vercel AI Gateway.
 * The Next.js runtime satisfies the same interface with the Vercel AI SDK
 * (lib/model.ts).
 */

import type { Ai, ModelRequest } from "../_shared/model.ts";
import { AI_GATEWAY_API_KEY, AI_GATEWAY_BASE } from "./config.ts";

const CHAT_MODEL = "anthropic/claude-haiku-4-5";
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

export const ai: Ai = {
	async generate(req: ModelRequest): Promise<string> {
		const r = await fetch(`${AI_GATEWAY_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: CHAT_MODEL,
				max_tokens: req.maxOutputTokens,
				...(req.jsonObject ? { response_format: { type: "json_object" } } : {}),
				messages: [
					{ role: "system", content: req.system },
					{ role: "user", content: req.prompt },
				],
			}),
		});
		if (!r.ok) {
			const msg = await r.text().catch(() => "");
			throw new Error(`AI Gateway chat failed: ${r.status} ${msg}`);
		}
		const d = await r.json();
		return d.choices[0].message.content as string;
	},

	async embed(text: string): Promise<number[]> {
		const r = await fetch(`${AI_GATEWAY_BASE}/embeddings`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
		});
		if (!r.ok) {
			const msg = await r.text().catch(() => "");
			throw new Error(`AI Gateway embeddings failed: ${r.status} ${msg}`);
		}
		const d = await r.json();
		return d.data[0].embedding;
	},
};

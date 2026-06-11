/**
 * The model-call seam. Every LLM-facing function in the shared layer takes
 * an `Ai` adapter instead of talking to a provider directly. Two adapters
 * exist in production — the Vercel AI SDK (Next.js / Node scripts) and a
 * raw fetch to the AI Gateway (Deno edge function) — plus fakes in tests.
 */

export type ModelRequest = {
	system: string;
	prompt: string;
	maxOutputTokens: number;
	/** Ask for JSON output mode where the adapter supports it. The prompts
	 * already demand raw JSON, so adapters may ignore this. */
	jsonObject?: boolean;
};

export type ModelUsage = { inputTokens: number; outputTokens: number };

export type Ai = {
	/** Returns the model's raw text response. Throws on transport errors. */
	generate(req: ModelRequest): Promise<string>;
	/** Like generate, but also reports token usage. Optional — production
	 * adapters implement it for callers that meter cost (the relevance
	 * gate); fakes may omit it and usage falls back to zero. */
	generateWithUsage?(req: ModelRequest): Promise<{ text: string; usage: ModelUsage }>;
	/** Returns the embedding vector for the given text. Throws on errors. */
	embed(text: string): Promise<number[]>;
};

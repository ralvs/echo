import { OPENROUTER_API_KEY, OPENROUTER_BASE } from "./config.ts";

export async function getEmbedding(text: string): Promise<number[]> {
	const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "openai/text-embedding-3-small",
			input: text,
		}),
	});
	if (!r.ok) {
		const msg = await r.text().catch(() => "");
		throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
	}
	const d = await r.json();
	return d.data[0].embedding;
}

export async function extractMetadata(text: string): Promise<Record<string, unknown>> {
	const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "anthropic/claude-haiku-4-5",
			max_tokens: 1024,
			response_format: { type: "json_object" },
			messages: [
				{
					role: "system",
					content: `Current date and time is ${new Date().toISOString()}. Use this to resolve relative dates and times (e.g. "next Monday", "tomorrow", "in 2 hours", "this afternoon") into absolute datetimes.

Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
- "category": a single domain category if clearly applicable (e.g. "plumbing", "italian", "gardening", "electrical", "baking"). null if not domain-specific.
- "location": physical location if mentioned (e.g. "garage", "kitchen", "school"). null if none.
- "cost": numeric dollar amount if mentioned (e.g. 150). null if none.
- "url": URL if mentioned. null if none.
- "rating": numeric 1-5 rating if expressed (e.g. "great" = 5, "terrible" = 1). null if no sentiment about a service/product.
- "due_at": if a single clear due/deadline date is mentioned, return it as ISO 8601 datetime (e.g. "2026-04-01T00:00:00Z"). null if no due date or if multiple distinct items have different due dates.
- "recurrence": if a repeating schedule is described, return an object with "interval_days" (number) and/or "unit" ("day"|"week"|"month"). null if not recurring.
- "priority": 0-4 (0=none, 1=low, 2=medium, 3=high, 4=urgent) based on urgency expressed. 0 if not expressed.
Only extract what's explicitly there. Do not infer or fabricate. Resolve relative dates using today's date.
Return ONLY valid JSON, no markdown fences or extra text.`,
				},
				{ role: "user", content: text },
			],
		}),
	});

	if (!r.ok) {
		const msg = await r.text().catch(() => "");
		console.error(`OpenRouter extraction failed: ${r.status} ${msg}`);
		return { topics: ["uncategorized"], type: "observation" };
	}

	const d = await r.json();
	try {
		const raw = d.choices[0].message.content as string;
		const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
		return JSON.parse(clean);
	} catch {
		return { topics: ["uncategorized"], type: "observation" };
	}
}

export async function decomposeWithLLM(
	text: string,
): Promise<{ content: string; type: string; topic: string }[] | null> {
	try {
		const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${OPENROUTER_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "anthropic/claude-haiku-4-5",
				max_tokens: 2048,
				response_format: { type: "json_object" },
				messages: [
					{
						role: "system",
						content: `You are an internal decomposition engine for a personal knowledge system.

Given a multi-topic input, split it into separate atomic thoughts. Each thought must be self-contained — a reader seeing only that thought should understand the full context.

For each atomic thought, produce:
- "content": a clear, self-contained statement (include enough context from the original)
- "type": one of "observation", "task", "idea", "reference", "person_note"
- "topic": a single short topic tag for this thought

Rules:
- Each thought covers ONE distinct topic or action
- Do NOT merge related but distinct items
- Do NOT drop any information from the original
- If a thought is triggered by context (e.g. "During project X review"), include that context in the content
- Keep each thought concise but complete

Return ONLY valid JSON: {"thoughts": [...]}`,
					},
					{ role: "user", content: text },
				],
			}),
		});

		if (!r.ok) {
			console.error("Decomposition LLM failed:", r.status, await r.text().catch(() => ""));
			return null;
		}

		const d = await r.json();
		const raw = d.choices[0].message.content as string;
		const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
		const parsed = JSON.parse(clean);

		if (!Array.isArray(parsed.thoughts) || parsed.thoughts.length < 2) {
			return null;
		}

		return parsed.thoughts;
	} catch (err) {
		console.error("Decomposition failed, saving as-is:", err);
		return null;
	}
}

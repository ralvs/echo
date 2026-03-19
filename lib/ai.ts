const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function getApiKey() {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("OPENROUTER_API_KEY is not set");
	return key;
}

export async function getEmbedding(text: string): Promise<number[]> {
	const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getApiKey()}`,
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

export async function extractMetadata(
	text: string,
): Promise<Record<string, unknown>> {
	const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getApiKey()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "openai/gpt-4o-mini",
			response_format: { type: "json_object" },
			messages: [
				{
					role: "system",
					content: `Extract metadata from the user's captured thought. Return JSON with:
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
- "contacts": array of contact objects {name, role?, phone?, email?} if vendor/service provider/contact info is mentioned. Empty array if none.
- "due_at": if a single clear due/deadline date is mentioned, return it as ISO 8601 datetime (e.g. "2026-04-01T00:00:00Z"). null if no due date or if multiple distinct items have different due dates.
- "recurrence": if a repeating schedule is described, return an object with "interval_days" (number) and/or "unit" ("day"|"week"|"month"). null if not recurring.
- "priority": 0-4 (0=none, 1=low, 2=medium, 3=high, 4=urgent) based on urgency expressed. 0 if not expressed.
Only extract what's explicitly there. Do not infer or fabricate.`,
				},
				{ role: "user", content: text },
			],
		}),
	});
	const d = await r.json();
	try {
		return JSON.parse(d.choices[0].message.content);
	} catch {
		return { topics: ["uncategorized"], type: "observation" };
	}
}

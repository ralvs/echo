import { embed, generateText } from "ai";

function getExtractionPrompt() {
	const now = new Date().toISOString();
	return `Current date and time is ${now}. Use this to resolve relative dates and times (e.g. "next Monday", "tomorrow", "in 2 hours", "this afternoon") into absolute datetimes.

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
Return ONLY valid JSON, no markdown fences or extra text.`;
}

export async function getEmbedding(text: string): Promise<number[]> {
	const { embedding } = await embed({
		model: "openai/text-embedding-3-small",
		value: text,
	});
	return embedding;
}

export async function extractMetadata(
	text: string,
): Promise<Record<string, unknown>> {
	try {
		const { text: content } = await generateText({
			model: "anthropic/claude-haiku-4-5",
			maxTokens: 1024,
			messages: [
				{ role: "system", content: getExtractionPrompt() },
				{ role: "user", content: text },
			],
		});
		const clean = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
		return JSON.parse(clean);
	} catch (err) {
		console.error("Failed to extract metadata:", err);
		return { topics: ["uncategorized"], type: "observation" };
	}
}

import { generateText } from "ai";
export { getEmbedding } from "./embeddings";
import { z } from "zod";

const ExtractionSchema = z.object({
	people: z.array(z.string()).default([]),
	action_items: z.array(z.string()).default([]),
	dates_mentioned: z.array(z.string()).default([]),
	topics: z.array(z.string()).default(["uncategorized"]),
	type: z.enum(["observation", "task", "idea", "reference", "person_note"]).default("observation"),
	memory_type: z.enum(["fact", "preference", "episodic", "procedural"]).default("episodic"),
	location: z.string().nullable().default(null),
	cost: z.number().nullable().default(null),
	url: z.string().nullable().default(null),
	rating: z.number().nullable().default(null),
	relationship: z.record(z.string(), z.string()).nullable().default(null),
	project: z.string().nullable().default(null),
	organization: z.string().nullable().default(null),
	sentiment: z.enum(["positive", "negative", "neutral"]).nullable().default(null),
	// Real DB columns — separated here so callers destructure rather than delete
	category: z.string().nullable().default(null),
	due_at: z.string().nullable().default(null),
	recurrence: z
		.object({
			interval_days: z.number().optional(),
			unit: z.enum(["day", "week", "month"]).optional(),
		})
		.nullable()
		.default(null),
	priority: z.number().min(0).max(4).default(0),
	expires_at: z.string().nullable().default(null),
	event_at: z.string().nullable().default(null),
});

export type ExtractedMetadata = z.infer<typeof ExtractionSchema>;

const FALLBACK: ExtractedMetadata = {
	people: [],
	action_items: [],
	dates_mentioned: [],
	topics: ["uncategorized"],
	type: "observation",
	memory_type: "episodic",
	location: null,
	cost: null,
	url: null,
	rating: null,
	relationship: null,
	project: null,
	organization: null,
	sentiment: null,
	category: null,
	due_at: null,
	recurrence: null,
	priority: 0,
	expires_at: null,
	event_at: null,
};

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
- "memory_type": one of:
    "fact" — persistent truths that don't change often (addresses, allergies, IDs, credentials, biographical details)
    "preference" — personal choices that may evolve (favorite tools, restaurants, habits, likes/dislikes)
    "episodic" — time-bound events, meetings, meals, conversations, travel, daily observations. DEFAULT when unsure.
    "procedural" — how-to knowledge, recipes, processes, setup guides, step-by-step instructions
- "expires_at": ISO 8601 datetime if the thought is inherently time-limited and becomes irrelevant after a specific moment (e.g. "dentist appointment next Monday" → that Monday). null if the thought retains value indefinitely.
- "event_at": ISO 8601 datetime of when the described event actually occurred or will occur, if different from right now. null if the thought describes the present moment or has no specific temporal anchor beyond now.
- "relationship": if people are mentioned and their relationship to the user is inferable, return an object mapping each person's name to their role (e.g. {"Sarah": "colleague", "Dr. Chen": "dentist", "Mom": "family"}). null if no people or roles are clear.
- "project": the name of a specific named project this thought belongs to, if clearly referenced (e.g. "Echo", "website redesign"). null if no named project.
- "organization": the name of a company or institution mentioned (e.g. "Anthropic", "Mayo Clinic"). null if none.
- "sentiment": overall sentiment of the thought toward its subject — "positive", "negative", or "neutral". null if purely informational with no discernible sentiment.
Only extract what's explicitly there. Do not infer or fabricate. Resolve relative dates using today's date.
Return ONLY valid JSON, no markdown fences or extra text.`;
}

export async function extractMetadata(text: string): Promise<ExtractedMetadata> {
	try {
		const { text: content } = await generateText({
			model: "anthropic/claude-haiku-4-5",
			maxOutputTokens: 1024,
			messages: [
				{ role: "system", content: getExtractionPrompt() },
				{ role: "user", content: text },
			],
		});
		const clean = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
		const parsed = ExtractionSchema.safeParse(JSON.parse(clean));
		return parsed.success ? parsed.data : FALLBACK;
	} catch (err) {
		console.error("Failed to extract metadata:", err);
		return FALLBACK;
	}
}

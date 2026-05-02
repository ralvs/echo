import { AI_GATEWAY_API_KEY, AI_GATEWAY_BASE } from "./config.ts";

/**
 * Builds the text that gets embedded for a thought.
 * Appends LLM-extracted metadata as structured suffixes so the vector
 * encodes semantic concepts (topics, category) alongside the raw content.
 */
export function buildEmbeddingText(
	content: string,
	metadata: { topics?: unknown; type?: string },
	category: string | null,
): string {
	const parts = [content];
	const topics = Array.isArray(metadata.topics) ? (metadata.topics as string[]) : [];
	if (topics.length) parts.push(`Topics: ${topics.join(", ")}`);
	if (category) parts.push(`Category: ${category}`);
	// Only append type when it adds signal — "observation" is the generic default
	if (metadata.type && metadata.type !== "observation") parts.push(`Type: ${metadata.type}`);
	return parts.join("\n\n");
}

export async function getEmbedding(text: string): Promise<number[]> {
	const r = await fetch(`${AI_GATEWAY_BASE}/embeddings`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "openai/text-embedding-3-small",
			input: text,
		}),
	});
	if (!r.ok) {
		const msg = await r.text().catch(() => "");
		throw new Error(`AI Gateway embeddings failed: ${r.status} ${msg}`);
	}
	const d = await r.json();
	return d.data[0].embedding;
}

export async function extractMetadata(text: string): Promise<Record<string, unknown>> {
	const r = await fetch(`${AI_GATEWAY_BASE}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
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
- "memory_type": one of:
    "fact" — persistent truths that don't change often (addresses, allergies, IDs, credentials, biographical details)
    "preference" — personal choices that may evolve (favorite tools, restaurants, habits, likes/dislikes)
    "episodic" — time-bound events, meetings, meals, conversations, travel, daily observations. DEFAULT when unsure.
    "procedural" — how-to knowledge, recipes, processes, setup guides, step-by-step instructions
- "expires_at": ISO 8601 datetime if the thought is inherently time-limited and becomes irrelevant after a specific moment (e.g. "dentist appointment next Monday" → that Monday; "exam on Friday" → that Friday end-of-day; "meeting tomorrow at 3pm" → tomorrow 3pm). null if the thought retains value indefinitely (facts, preferences, procedures, general observations).
- "event_at": ISO 8601 datetime of when the described event actually occurred or will occur, if different from right now. For past events ("last Tuesday I had lunch with Sarah" → last Tuesday), future events ("dentist next Monday" → next Monday), and specific dated references ("on March 15th we signed the contract" → that date). null if the thought describes the present moment or has no specific temporal anchor beyond now.
- "relationship": if people are mentioned and their relationship to the user is inferable, return an object mapping each person's name to their role (e.g. {"Sarah": "colleague", "Dr. Chen": "dentist", "Mom": "family"}). null if no people or roles are clear.
- "project": the name of a specific named project this thought belongs to, if clearly referenced (e.g. "Echo", "website redesign", "Q3 budget", "kitchen renovation"). null if no named project.
- "organization": the name of a company or institution mentioned (e.g. "Anthropic", "Mayo Clinic", "Apple", "MIT"). null if none.
- "sentiment": overall sentiment of the thought toward its subject — "positive", "negative", or "neutral". null if purely informational with no discernible sentiment.
Only extract what's explicitly there. Do not infer or fabricate. Resolve relative dates using today's date.
Return ONLY valid JSON, no markdown fences or extra text.`,
				},
				{ role: "user", content: text },
			],
		}),
	});

	if (!r.ok) {
		const msg = await r.text().catch(() => "");
		console.error(`AI Gateway extraction failed: ${r.status} ${msg}`);
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

export async function classifyRelation(
	newText: string,
	existingText: string,
): Promise<{
	relation: "updates" | "extends" | "derives" | "related" | "unrelated";
	confidence: number;
} | null> {
	try {
		const r = await fetch(`${AI_GATEWAY_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "anthropic/claude-haiku-4-5",
				max_tokens: 256,
				response_format: { type: "json_object" },
				messages: [
					{
						role: "system",
						content: `Classify the relationship between two thoughts from a personal knowledge base.

Relationship types:
- "updates": New thought contradicts or replaces the old (e.g. corrected phone number, changed preference)
- "extends": New thought adds detail without replacing (e.g. follow-up note on same topic)
- "derives": New thought is a logical consequence of the old (e.g. decision made based on earlier research)
- "related": Topically connected but independent
- "unrelated": No meaningful relationship despite surface similarity

Return ONLY valid JSON: {"relation": "<type>", "confidence": <0.0-1.0>}`,
					},
					{
						role: "user",
						content: `EXISTING THOUGHT:\n${existingText}\n\nNEW THOUGHT:\n${newText}`,
					},
				],
			}),
		});

		if (!r.ok) return null;

		const d = await r.json();
		const raw = d.choices[0].message.content as string;
		const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
		const parsed = JSON.parse(clean);

		if (!parsed.relation || typeof parsed.confidence !== "number") return null;
		if (parsed.confidence < 0.5) return null;

		return parsed;
	} catch {
		return null;
	}
}

export async function compileTopicPage(
	title: string,
	existingSummary: string | null,
	newThoughts: { content: string; created_at: string; memory_type?: string }[],
): Promise<string> {
	const thoughtsText = newThoughts
		.map((t, i) => `[${i + 1}] (${new Date(t.created_at).toLocaleDateString()}) ${t.content}`)
		.join("\n\n");

	const systemPrompt = existingSummary
		? `You maintain a personal knowledge wiki page. Given the current page summary and new thoughts to integrate, produce an updated markdown summary.

Rules:
- Preserve all existing knowledge; integrate new information smoothly
- If new thoughts contradict existing facts, note the conflict and show the latest value
- Keep it concise and structured — use headers, bullet points, and bold key facts
- Do NOT add preamble like "Here is the updated summary"
- Return ONLY the markdown content`
		: `You are creating a new personal knowledge wiki page. Given a set of captured thoughts, produce a structured markdown summary of everything known about this topic.

Rules:
- Organize by sub-topic using headers
- Bold key facts, names, and values
- Keep it concise but complete — include all meaningful details
- Do NOT add preamble
- Return ONLY the markdown content`;

	const userContent = existingSummary
		? `# Current Page: ${title}\n\n${existingSummary}\n\n---\n\nNew thoughts to integrate:\n\n${thoughtsText}`
		: `Topic: ${title}\n\nThoughts to compile:\n\n${thoughtsText}`;

	try {
		const r = await fetch(`${AI_GATEWAY_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "anthropic/claude-haiku-4-5",
				max_tokens: 2048,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userContent },
				],
			}),
		});

		if (!r.ok) return existingSummary ?? `# ${title}\n\n*(compilation failed)*`;
		const d = await r.json();
		return (d.choices[0].message.content as string).trim();
	} catch {
		return existingSummary ?? `# ${title}\n\n*(compilation failed)*`;
	}
}

export function identifyTopicPage(
	topics: string[],
	existingPages: { slug: string; title: string; embedding: number[] }[],
	thoughtEmbedding: number[],
	_CREATION_THRESHOLD: number = 3,
): { slug: string; title: string; isNew: boolean } | null {
	if (!topics.length) return null;

	// Normalize topic to slug
	const toSlug = (t: string) =>
		t
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");

	// 1. Exact slug match
	for (const topic of topics) {
		const slug = toSlug(topic);
		const match = existingPages.find((p) => p.slug === slug);
		if (match) return { slug: match.slug, title: match.title, isNew: false };
	}

	// 2. Embedding similarity match (>0.85)
	if (existingPages.length > 0) {
		let bestSim = 0;
		let bestPage: (typeof existingPages)[0] | null = null;

		for (const page of existingPages) {
			if (!page.embedding?.length) continue;
			let dot = 0;
			let normA = 0;
			let normB = 0;
			for (let i = 0; i < thoughtEmbedding.length; i++) {
				dot += thoughtEmbedding[i] * page.embedding[i];
				normA += thoughtEmbedding[i] ** 2;
				normB += page.embedding[i] ** 2;
			}
			const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
			if (sim > bestSim) {
				bestSim = sim;
				bestPage = page;
			}
		}

		if (bestSim > 0.85 && bestPage) {
			return { slug: bestPage.slug, title: bestPage.title, isNew: false };
		}
	}

	// 3. No match — signal potential new page (caller checks count threshold)
	const primaryTopic = topics[0];
	return {
		slug: toSlug(primaryTopic),
		title: primaryTopic
			.split(/[\s-]+/)
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" "),
		isNew: true,
	};
}

export async function detectContradictions(
	facts: { id: string; content: string; topics: string[] }[],
): Promise<{ thought_a: string; thought_b: string; explanation: string }[]> {
	if (facts.length < 2) return [];

	// Group by topic overlap — only send clusters to the LLM
	const clusters: Map<string, typeof facts> = new Map();
	for (const fact of facts) {
		for (const topic of fact.topics) {
			const key = topic.toLowerCase();
			if (!clusters.has(key)) clusters.set(key, []);
			clusters.get(key)?.push(fact);
		}
	}

	const results: { thought_a: string; thought_b: string; explanation: string }[] = [];
	const seen = new Set<string>();

	for (const [, cluster] of clusters) {
		if (cluster.length < 2) continue;

		// Deduplicate cluster entries by ID
		const unique = cluster.filter((f, i, arr) => arr.findIndex((x) => x.id === f.id) === i);
		if (unique.length < 2) continue;

		const factsText = unique.map((f, i) => `[${i + 1}] (ID: ${f.id}) ${f.content}`).join("\n\n");

		try {
			const r = await fetch(`${AI_GATEWAY_BASE}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "anthropic/claude-haiku-4-5",
					max_tokens: 512,
					response_format: { type: "json_object" },
					messages: [
						{
							role: "system",
							content: `You are checking a personal knowledge base for contradictions. Given a list of facts, identify any pairs that directly contradict each other (different values for the same thing, e.g. two different addresses, two different phone numbers, conflicting statements).

Return ONLY valid JSON: {"contradictions": [{"thought_a": "<id>", "thought_b": "<id>", "explanation": "<brief reason>"}]}
If there are no contradictions, return: {"contradictions": []}`,
						},
						{ role: "user", content: factsText },
					],
				}),
			});

			if (!r.ok) continue;
			const d = await r.json();
			const raw = d.choices[0].message.content as string;
			const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
			const parsed = JSON.parse(clean);

			for (const c of parsed.contradictions ?? []) {
				const pairKey = [c.thought_a, c.thought_b].sort().join("|");
				if (!seen.has(pairKey)) {
					seen.add(pairKey);
					results.push(c);
				}
			}
		} catch {
			// Skip failed clusters
		}
	}

	return results;
}

export async function decomposeWithLLM(
	text: string,
): Promise<{ content: string; type: string; topic: string }[] | null> {
	try {
		const r = await fetch(`${AI_GATEWAY_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
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

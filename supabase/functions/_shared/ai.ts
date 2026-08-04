/**
 * Every LLM-facing function in Echo: metadata extraction, relation
 * classification, decomposition, contradiction detection, and topic/entity
 * page compilation. Schemas and prompts live here once — both runtimes
 * call through the `Ai` model-call seam (see model.ts), so prompt tuning
 * is a single edit and the schemas cannot drift between runtimes.
 */

import { z } from "zod";
import type { Ai, ModelUsage } from "./model.ts";
import type { PersonRecord } from "./types.ts";

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
	tools: z.array(z.string()).default([]),
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
	person_definitions: z
		.array(z.object({ canonical_name: z.string(), role: z.string() }))
		.default([]),
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
	tools: [],
	category: null,
	due_at: null,
	recurrence: null,
	priority: 0,
	expires_at: null,
	event_at: null,
	person_definitions: [],
};

function getExtractionPrompt(knownPeople: PersonRecord[] = []): string {
	const now = new Date().toISOString();
	const knownSection =
		knownPeople.length > 0
			? `Known people — resolve any mention of these roles or relationship terms to the canonical name. Include the canonical name in "people" even when the thought only uses the role (e.g. "my mother-in-law gave us..." → people: ["Andrea"]):\n${knownPeople
					.map((p) => {
						const refs = [...new Set([p.role, ...p.aliases])].filter(Boolean);
						return `- ${p.canonical_name}: referred to as ${refs.join(", ")}`;
					})
					.join("\n")}\n\n`
			: "";
	return `Current date and time is ${now}. Use this to resolve relative dates and times (e.g. "next Monday", "tomorrow", "in 2 hours", "this afternoon") into absolute datetimes.

${knownSection}Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned — use canonical names when known (empty if none)
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
- "person_definitions": if this thought explicitly states who someone is (e.g. "my mother-in-law is called Andrea", "John is my brother"), list each as {"canonical_name": "Andrea", "role": "mother-in-law"}. Empty array otherwise.
- "project": the name of a specific named project this thought belongs to, if clearly referenced (e.g. "Echo", "website redesign"). null if no named project.
- "organization": the name of a company or institution mentioned (e.g. "Anthropic", "Mayo Clinic"). null if none.
- "tools": array of named tools, products, software, or services mentioned (e.g. "Supabase", "Next.js", "Figma", "DeWalt drill"). Empty array if none.
- "sentiment": overall sentiment of the thought toward its subject — "positive", "negative", or "neutral". null if purely informational with no discernible sentiment.
Only extract what's explicitly there. Do not infer or fabricate. Resolve relative dates using today's date.
Return ONLY valid JSON, no markdown fences or extra text.`;
}

/**
 * Builds the text that gets embedded for a thought.
 * Appends LLM-extracted metadata as structured suffixes so the vector
 * encodes semantic concepts (topics, category) alongside the raw content.
 *
 * When the Owner's name is known, the content is anchored with an
 * "About <owner>:" prefix. First-person captures ("Got a raise…") otherwise
 * never mention the Owner, while retrieval queries usually do — the anchor
 * closes that perspective gap in the vector space.
 */
export function buildEmbeddingText(
	content: string,
	metadata: { topics?: unknown; type?: string; people?: unknown },
	category: string | null,
	ownerName?: string | null,
): string {
	const parts = [ownerName ? `About ${ownerName}: ${content}` : content];
	const topics = Array.isArray(metadata.topics) ? (metadata.topics as string[]) : [];
	if (topics.length) parts.push(`Topics: ${topics.join(", ")}`);
	if (category) parts.push(`Category: ${category}`);
	// Only append type when it adds signal — "observation" is the generic default
	if (metadata.type && metadata.type !== "observation") parts.push(`Type: ${metadata.type}`);
	const people = Array.isArray(metadata.people) ? (metadata.people as string[]) : [];
	if (people.length) parts.push(`People: ${people.join(", ")}`);
	return parts.join("\n\n");
}

export async function extractMetadata(
	ai: Ai,
	text: string,
	knownPeople: PersonRecord[] = [],
): Promise<ExtractedMetadata> {
	try {
		const raw = await ai.generate({
			system: getExtractionPrompt(knownPeople),
			prompt: text,
			maxOutputTokens: 1024,
			jsonObject: true,
		});
		const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
		const parsed = ExtractionSchema.safeParse(JSON.parse(clean));
		return parsed.success ? parsed.data : FALLBACK;
	} catch (err) {
		console.error("Metadata extraction failed:", err);
		return FALLBACK;
	}
}

export async function classifyRelation(
	ai: Ai,
	newText: string,
	existingText: string,
): Promise<{
	relation: "updates" | "extends" | "derives" | "related" | "unrelated";
	confidence: number;
} | null> {
	try {
		const raw = await ai.generate({
			system: `Classify the relationship between two thoughts from a personal knowledge base.
You MUST pick exactly one of these relation values: updates, extends, derives, related, unrelated.
- updates: new contradicts/replaces old
- extends: new adds detail to old without replacing
- derives: new is a logical consequence of old
- related: topically linked but independent
- unrelated: no meaningful link

Respond with ONLY a raw JSON object (no markdown): {"relation":"<value>","confidence":<0.0-1.0>}`,
			prompt: `EXISTING THOUGHT:\n${existingText}\n\nNEW THOUGHT:\n${newText}`,
			maxOutputTokens: 256,
		});

		const jsonMatch = raw.match(/\{[^{}]*\}/);
		if (!jsonMatch) return null;
		const parsed = JSON.parse(jsonMatch[0]);

		if (!parsed.relation || typeof parsed.confidence !== "number") return null;
		if (parsed.confidence < 0.5) return null;
		const validTypes = ["updates", "extends", "derives", "related", "unrelated"] as const;
		if (!validTypes.includes(parsed.relation)) return null;

		return parsed;
	} catch {
		return null;
	}
}

export async function compileTopicPage(
	ai: Ai,
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
		const raw = await ai.generate({
			system: systemPrompt,
			prompt: userContent,
			maxOutputTokens: 2048,
		});
		return raw.trim();
	} catch {
		return existingSummary ?? `# ${title}\n\n*(compilation failed)*`;
	}
}

/**
 * Compiles a graph-backed entity wiki page. Unlike topic pages, the prompt is
 * given the entity's typed identity and its related entities (from co-occurrence
 * edges) so the summary can describe the entity's place in the wider graph.
 * Always a full recompile from the supplied thoughts (entity thought sets are
 * small), so existingSummary is intentionally not threaded through.
 */
export async function compileEntityPage(
	ai: Ai,
	name: string,
	entityType: string,
	thoughts: { content: string; created_at: string }[],
	related: { name: string; type: string; weight: number }[],
): Promise<string> {
	const thoughtsText = thoughts
		.map((t, i) => `[${i + 1}] (${new Date(t.created_at).toLocaleDateString()}) ${t.content}`)
		.join("\n\n");

	const relatedText = related.length
		? related.map((r) => `- ${r.name} (${r.type}, co-mentioned ${r.weight}×)`).join("\n")
		: "(none)";

	const systemPrompt = `You are compiling a personal knowledge wiki page about a single ${entityType} named "${name}".
Given everything captured that mentions this ${entityType}, plus the entities it most often co-occurs with, produce a structured markdown summary.

Rules:
- Lead with what this ${entityType} is and the user's relationship to it
- Organize details under headers; bold key facts, dates, and values
- Note open questions, tasks, or recent changes if present
- End with a short "Related" section referencing the co-occurring entities that matter, in prose (omit if none are meaningful)
- Only use information explicitly present — do not infer or fabricate
- Do NOT add preamble; return ONLY the markdown content`;

	const userContent = `${entityType}: ${name}\n\nCo-occurring entities:\n${relatedText}\n\nCaptured thoughts:\n\n${thoughtsText}`;

	try {
		const raw = await ai.generate({
			system: systemPrompt,
			prompt: userContent,
			maxOutputTokens: 2048,
		});
		return raw.trim();
	} catch {
		return `# ${name}\n\n*(compilation failed)*`;
	}
}

export function identifyTopicPage(
	topics: string[],
	existingPages: { slug: string; title: string; embedding: number[] }[],
	thoughtEmbedding: number[],
	_CREATION_THRESHOLD: number = 3,
): { slug: string; title: string; isNew: boolean } | null {
	if (!topics.length) return null;

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
	ai: Ai,
	facts: { id: string; content: string; topics: string[] }[],
): Promise<{ thought_a: string; thought_b: string; explanation: string }[]> {
	if (facts.length < 2) return [];

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

		const unique = cluster.filter((f, i, arr) => arr.findIndex((x) => x.id === f.id) === i);
		if (unique.length < 2) continue;

		const factsText = unique.map((f, i) => `[${i + 1}] (ID: ${f.id}) ${f.content}`).join("\n\n");

		try {
			const raw = await ai.generate({
				system: `You are checking a personal knowledge base for contradictions. Given a list of facts, identify any pairs that directly contradict each other (different values for the same thing, e.g. two different addresses, two different phone numbers, conflicting statements).

Return ONLY valid JSON: {"contradictions": [{"thought_a": "<id>", "thought_b": "<id>", "explanation": "<brief reason>"}]}
If there are no contradictions, return: {"contradictions": []}`,
				prompt: factsText,
				maxOutputTokens: 512,
				jsonObject: true,
			});

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

export type ProfileStaticRow = {
	content: string;
	metadata: Record<string, unknown> | null;
};

export type ProfileDynamicRow = ProfileStaticRow & {
	due_at: string | null;
	priority: number | null;
};

export type UserProfile = {
	static?: {
		facts?: string[];
		preferences?: string[];
		contact_graph?: { name: string; role: string }[];
		organizations?: string[];
	};
	dynamic?: {
		active_projects?: string[];
		upcoming_events?: string[];
		recent_topics?: string[];
		open_tasks?: string[];
		sentiment_patterns?: string[];
	};
	summary?: string;
};

function relationshipTags(metadata: Record<string, unknown>): string {
	const rel = metadata.relationship;
	if (!rel || typeof rel !== "object") return "";
	return Object.entries(rel as Record<string, string>)
		.map(([name, role]) => `${name}=${role}`)
		.join(", ");
}

/** Renders the static thought set into the tagged lines the profile prompt
 * keys on ([org: ...], [relationships: ...]). */
function buildStaticBlock(rows: ProfileStaticRow[]): string {
	return rows
		.map((t) => {
			const m = t.metadata || {};
			let line = `- ${t.content}`;
			if (m.organization) line += ` [org: ${m.organization}]`;
			const rels = relationshipTags(m);
			if (rels) line += ` [relationships: ${rels}]`;
			return line;
		})
		.join("\n");
}

function buildDynamicBlock(rows: ProfileDynamicRow[]): string {
	return rows
		.map((t) => {
			const m = t.metadata || {};
			const tags: string[] = [];
			if (m.status) tags.push(`[${m.status}]`);
			if (t.due_at) tags.push(`due:${t.due_at}`);
			if (t.priority && t.priority > 0) tags.push(`P${t.priority}`);
			if (m.project) tags.push(`project:${m.project}`);
			if (m.organization) tags.push(`org:${m.organization}`);
			if (m.sentiment) tags.push(`sentiment:${m.sentiment}`);
			const rels = relationshipTags(m);
			if (rels) tags.push(`rels:${rels}`);
			const suffix = tags.length ? ` (${tags.join(", ")})` : "";
			return `- ${t.content}${suffix}`;
		})
		.join("\n");
}

/**
 * Synthesizes the structured user profile from the static (facts and
 * preferences) and dynamic (recent episodes and open tasks) thought sets.
 * The block rendering lives here because the prompt's rules reference the
 * tags it produces. Throws when the model response can't be parsed.
 */
export async function synthesizeProfile(
	ai: Ai,
	staticThoughts: ProfileStaticRow[],
	dynamicThoughts: ProfileDynamicRow[],
	focus?: string,
): Promise<UserProfile> {
	const staticBlock = buildStaticBlock(staticThoughts);
	const dynamicBlock = buildDynamicBlock(dynamicThoughts);

	const raw = await ai.generate({
		system: `Synthesize a structured user profile from these captured thoughts.

STATIC FACTS & PREFERENCES (persistent):
${staticBlock || "(none yet)"}

RECENT EPISODES & ACTIVE TASKS (dynamic):
${dynamicBlock || "(none yet)"}

Return JSON with this structure:
{
  "static": {
    "facts": ["..."],
    "preferences": ["..."],
    "contact_graph": [{"name": "...", "role": "..."}],
    "organizations": ["..."]
  },
  "dynamic": {
    "active_projects": ["..."],
    "upcoming_events": ["..."],
    "recent_topics": ["..."],
    "open_tasks": ["..."],
    "sentiment_patterns": ["..."]
  },
  "summary": "A 2-3 sentence natural language summary of who this person is and what they're currently focused on."
}

Rules:
- Only include information explicitly present in the thoughts
- Keep each array entry concise (one sentence max)
- contact_graph: build from [relationships: ...] tags — each unique person with their role
- organizations: unique company/institution names from [org: ...] tags
- active_projects: use [project: ...] tags as primary signal, supplement with free-text inference
- sentiment_patterns: note any recurring emotional patterns (e.g. "consistently negative about X", "positive about Y")
- Empty arrays are fine if no relevant data exists
${focus ? `- Emphasize information related to: ${focus}` : ""}
Return ONLY valid JSON.`,
		prompt: "Generate my profile.",
		maxOutputTokens: 2048,
		jsonObject: true,
	});

	const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
	return JSON.parse(clean) as UserProfile;
}

export async function decomposeWithLLM(
	ai: Ai,
	text: string,
): Promise<{ content: string; type: string; topic: string }[] | null> {
	try {
		const raw = await ai.generate({
			system: `You are an internal decomposition engine for a personal knowledge system.

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
			prompt: text,
			maxOutputTokens: 2048,
			jsonObject: true,
		});

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

/** One user→assistant turn handed to the dream classifier, along with the
 * existing memories retrieved for it (see dream.ts's grounding step). Only
 * ids present in `groundedMemories` are trustworthy — the classifier is
 * asked to pick target ids from that list rather than invent them. */
export type DreamClassifyItem = {
	sessionId: string;
	turnIndex: number;
	userMessage: string;
	assistantMessage: string;
	at: string;
	groundedMemories: { id: string; content: string }[];
};

const DreamProposalSchema = z.object({
	session_id: z.string(),
	turn_index: z.number(),
	category: z.enum(["correction", "preference", "new_fact", "stale", "duplicate"]),
	action: z.enum(["create", "update", "supersede", "merge", "expire"]),
	target_ids: z.array(z.string()).default([]),
	proposed_content: z.string(),
	quote: z.string(),
	confidence: z.number().min(0).max(1),
	rationale: z.string(),
});

const DreamProposeSchema = z.object({
	proposals: z.array(DreamProposalSchema).default([]),
});

export type RawDreamProposal = z.infer<typeof DreamProposalSchema>;

export type ProposeMemoryChangesResult = {
	proposals: RawDreamProposal[];
	usage: ModelUsage;
};

const NO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Classifies a batch of grounded transcript turns into candidate memory
 * changes. Fails closed like relevanceGate: any transport error or schema
 * mismatch returns zero proposals rather than throwing, so a single bad
 * model response can never crash the nightly dream run.
 */
export async function proposeMemoryChanges(
	ai: Ai,
	batch: DreamClassifyItem[],
): Promise<ProposeMemoryChangesResult> {
	if (!batch.length) return { proposals: [], usage: NO_USAGE };

	const itemsText = batch
		.map((item, i) => {
			const grounded = item.groundedMemories.length
				? item.groundedMemories.map((m) => `  - (ID: ${m.id}) ${m.content}`).join("\n")
				: "  (none)";
			return `[${i + 1}] session_id: ${item.sessionId}, turn_index: ${item.turnIndex}, at: ${item.at}
User: ${item.userMessage}
Assistant: ${item.assistantMessage}
Existing related memories:
${grounded}`;
		})
		.join("\n\n");

	const req = {
		system: `You review Claude Code / Grok session turns against a personal knowledge base and propose memory changes for the Owner to approve. You never write anything yourself — you only propose.

For each turn that reveals something worth remembering, updating, or retiring, emit one proposal:
- "category": one of "correction" (the owner corrected something previously stored), "preference" (a preference stated or changed), "new_fact" (a durable fact not yet stored), "stale" (an existing memory the turn shows is now wrong or outdated), "duplicate" (the turn restates something already stored near-identically)
- "action": one of "create" (no existing memory covers this — target_ids MUST be empty), "update" (a real memory needs its content revised), "supersede" (a real memory is now wrong and should be replaced), "merge" (near-duplicate real memories should be combined), "expire" (a real memory is no longer relevant and should be hidden, not deleted)
- "target_ids": the exact "ID: ..." values from "Existing related memories" that this proposal concerns. Only use ids that appear verbatim in that list — never invent an id. Empty array for "create".
- "proposed_content": a self-contained statement suitable to save as the new/updated memory
- "quote": the exact substring of the User or Assistant message that is the evidence for this proposal
- "confidence": 0.0-1.0
- "rationale": one sentence explaining the proposal
- "session_id" and "turn_index": copy verbatim from the turn this proposal is about

Skip turns that don't warrant a change. Return ONLY valid JSON: {"proposals": [...]}. Empty array if nothing to propose.`,
		prompt: itemsText,
		// 4096, paired with dream.ts's CLASSIFY_BATCH_SIZE (kept small enough that
		// a full batch's worth of proposals comfortably fits) — a real run at
		// 2048 truncated mid-string on larger batches (SyntaxError: Unterminated
		// string), which the schema parse fails closed on, but silently wastes
		// the whole batch's proposals. Don't tune one without the other.
		maxOutputTokens: 4096,
		jsonObject: true,
	};

	// Hoisted out of the try: on a parse throw below, the catch must still
	// return the tokens actually spent (already reflected in `usage` once the
	// model call itself succeeded), not NO_USAGE — an unattended run tracking
	// spend against --max-usd would otherwise undercount every malformed
	// response and blow past the cap.
	let usage: ModelUsage = NO_USAGE;
	try {
		const result = ai.generateWithUsage
			? await ai.generateWithUsage(req)
			: { text: await ai.generate(req), usage: NO_USAGE };
		usage = result.usage;
		const clean = result.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
		const parsed = DreamProposeSchema.safeParse(JSON.parse(clean));
		if (!parsed.success) return { proposals: [], usage };
		return { proposals: parsed.data.proposals, usage };
	} catch (err) {
		console.error("Dream classification failed:", err);
		return { proposals: [], usage };
	}
}

/** One candidate pair from findDuplicates, handed to confirmDuplicateMerges
 * for an LLM verdict before it may become a merge proposal. `pair_id` is
 * caller-assigned (e.g. "thought_a|thought_b") and echoed back verbatim so
 * the caller can re-associate a verdict with its pair without trusting the
 * model to preserve target ids. */
export type DuplicateCandidate = { pair_id: string; content_a: string; content_b: string };

export type DuplicateVerdict = {
	pair_id: string;
	same_fact: boolean;
	merged_content: string; // "" when same_fact is false
	reason: string;
};

const DuplicateVerdictSchema = z.object({
	pair_id: z.string(),
	same_fact: z.boolean(),
	merged_content: z.string().default(""),
	reason: z.string().default(""),
});

const ConfirmDuplicateMergesSchema = z.object({
	verdicts: z.array(DuplicateVerdictSchema).default([]),
});

export type ConfirmDuplicateMergesResult = {
	verdicts: DuplicateVerdict[];
	usage: ModelUsage;
};

/**
 * findDuplicates (see lint.ts) is a lint heuristic for human eyeballing —
 * its own output says "delete one or merge" — not a merge instruction. Two
 * thoughts sitting at 0.95+ cosine similarity can still describe entirely
 * different entities/events (e.g. AC service records for different rooms,
 * on different dates, at different costs) when they share sentence
 * structure. confirmDuplicateMerges is the gate between "candidate pair"
 * and "actionable merge proposal": it asks the model to judge same-fact-ness
 * explicitly, and fails closed like proposeMemoryChanges/relevanceGate — any
 * transport error, schema mismatch, or missing verdict must be treated as
 * "not a duplicate" rather than silently letting a merge through.
 */
export async function confirmDuplicateMerges(
	ai: Ai,
	candidates: DuplicateCandidate[],
): Promise<ConfirmDuplicateMergesResult> {
	if (!candidates.length) return { verdicts: [], usage: NO_USAGE };

	const itemsText = candidates
		.map((c, i) => `[${i + 1}] pair_id: ${c.pair_id}\nA: ${c.content_a}\nB: ${c.content_b}`)
		.join("\n\n");

	const req = {
		system: `You review candidate duplicate pairs flagged by an embedding-similarity heuristic in a personal knowledge base, and decide whether each pair is actually the same fact and safe to merge. The heuristic only measures textual similarity, so it frequently flags pairs that are NOT duplicates — you are the safety check before anything gets merged and one of the two records gets destroyed.

Two thoughts are the same fact ONLY if they record the same entity/event and differ merely in phrasing, level of detail, or recency (e.g. one is a shorter/older restatement of the other).

They are NOT the same fact when they describe different subjects, instances, locations, units, people, dates, or amounts — even when the wording is nearly identical. Worked negative example: "AC cleaning service — Living room unit, last cleaned April 14, 2026, cost R$130" and "AC cleaning service — Office unit, last cleaned April 2, 2026, cost R$150" share sentence structure and score high on cosine similarity, but they are two different AC units with different dates and costs — same_fact must be false for a pair like this.

When uncertain, answer same_fact: false. Uncertainty must never produce a merge — a false "not a duplicate" costs nothing (the pair just isn't merged), but a false "same fact" silently destroys one of the two records.

For each pair, return:
- "pair_id": copied verbatim from the input
- "same_fact": true only if the two thoughts are unambiguously the same entity/event
- "merged_content": when same_fact is true, the single memory that should replace both — it must preserve every distinct detail present in either A or B. "" when same_fact is false.
- "reason": one sentence explaining the verdict

Return ONLY valid JSON: {"verdicts": [...]}. One verdict per input pair.`,
		prompt: itemsText,
		maxOutputTokens: 2048,
		jsonObject: true,
	};

	// Same hoisting rationale as proposeMemoryChanges: usage must reach the
	// caller even on a parse failure so budget tracking stays accurate.
	let usage: ModelUsage = NO_USAGE;
	try {
		const result = ai.generateWithUsage
			? await ai.generateWithUsage(req)
			: { text: await ai.generate(req), usage: NO_USAGE };
		usage = result.usage;
		const clean = result.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
		const parsed = ConfirmDuplicateMergesSchema.safeParse(JSON.parse(clean));
		if (!parsed.success) return { verdicts: [], usage };
		return { verdicts: parsed.data.verdicts, usage };
	} catch (err) {
		console.error("Duplicate merge confirmation failed:", err);
		return { verdicts: [], usage };
	}
}

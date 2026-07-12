/**
 * The Capture pipeline — the one place that defines what "capture a thought"
 * means: idempotency, metadata extraction, enriched embedding, decomposition,
 * explicit provenance, and the compounding side effects (relation detection,
 * topic pages, entity graph, person definitions).
 *
 * Both the Next.js API route and the MCP capture_thought tool are adapters
 * over captureThought(), so every capture source compounds the same way.
 */

import { classifyRelation, decomposeWithLLM, extractMetadata } from "./ai.ts";
import type { EchoDeps } from "./deps.ts";
import { extractEntityMentions, linkThoughtEntities } from "./entities.ts";
import { updateEntityPagesForThought } from "./entity-pages.ts";
import { backfillPersonAlias, getKnownPeople, upsertPerson } from "./people.ts";
import { projectThought } from "./projection.ts";
import { updateTopicPagesForThought } from "./topic-pages.ts";
import type { PersonDefinition, PersonRecord, RecurrenceRule, Thought } from "./types.ts";

const THOUGHT_COLUMNS =
	"id, content, metadata, version, due_at, expires_at, event_at, recurrence, priority, category, source_id, source_kind, created_at, updated_at";

const DEFAULT_DECOMPOSE_MIN_TOKENS = 200;

export type CaptureInput = {
	content: string;
	/** Override auto-detected type (observation, task, idea, …). */
	type?: string;
	/** Override auto-detected topics — array or comma-separated string. */
	topics?: string[] | string;
	/** Override auto-detected memory type (fact, preference, episodic, procedural). */
	memory_type?: string;
	due_at?: string | null;
	recurrence?: RecurrenceRule | null;
	priority?: number | null;
	category?: string | null;
	expires_at?: string | null;
	/** Explicit provenance: creates `derives` relations at confidence 1.0. */
	source_ids?: string[];
	/** External idempotency key — capture is skipped if already present. */
	source_id?: string | null;
	source_kind?: string | null;
};

export type CaptureOptions = {
	/** Tag stored on metadata.source ("echo" for the API, "mcp" for the tool). */
	source?: string;
	/** Enable decomposition of long multi-topic inputs (default true). */
	decompose?: boolean;
	decomposeMinTokens?: number;
	/**
	 * Scheduler for fire-and-forget side effects (topic pages, entity graph,
	 * person backfill). Defaults to floating the promise with error logging;
	 * the Next.js adapter passes `after()` so work survives the response.
	 */
	background?: (work: Promise<unknown>) => void;
};

export type CaptureResult =
	| { kind: "duplicate"; id: string; source_id: string }
	| { kind: "captured"; thought: Thought; relations: string[] }
	| {
			kind: "decomposed";
			parent: Thought;
			children: { id: string; topic: string }[];
			relations: string[];
	  };

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function hasMultipleTopics(text: string): boolean {
	const bullets = (text.match(/^[\t ]*[-*•]\s+/gm) || []).length;
	const headers = (text.match(/^#{1,3}\s+/gm) || []).length;
	const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 30);
	return bullets >= 3 || headers >= 2 || paragraphs.length >= 3;
}

export async function captureThought(
	deps: EchoDeps,
	input: CaptureInput,
	options: CaptureOptions = {},
): Promise<CaptureResult> {
	const { db } = deps;
	const source = options.source ?? "echo";
	const background =
		options.background ??
		((work: Promise<unknown>) => {
			work.catch((e) => console.error("Capture side effect failed:", e));
		});

	// Idempotency check — short-circuit if already captured from this source.
	if (input.source_id) {
		const { data: existing } = await db
			.from("thoughts")
			.select("id")
			.eq("source_id", input.source_id)
			.maybeSingle();
		if (existing) {
			return { kind: "duplicate", id: existing.id, source_id: input.source_id };
		}
	}

	const knownPeople = await getKnownPeople(db).catch(() => [] as PersonRecord[]);

	// Decomposition policy: single interface hides the heuristic + LLM fallback.
	const decomposeEnabled = options.decompose ?? true;
	const minTokens = options.decomposeMinTokens ?? DEFAULT_DECOMPOSE_MIN_TOKENS;
	const atomicThoughts =
		decomposeEnabled &&
		estimateTokens(input.content) >= minTokens &&
		hasMultipleTopics(input.content)
			? await decomposeWithLLM(deps.ai, input.content)
			: null;

	if (!atomicThoughts) {
		const saved = await saveSingleThought(deps, input.content, input, knownPeople, source);
		if (saved.kind === "duplicate") return saved;

		if (input.source_ids?.length) {
			await insertSourceRelations(db, saved.thought.id, input.source_ids);
		}

		const relations = await runCompoundingPipeline(deps, background, saved, undefined);
		return { kind: "captured", thought: saved.thought, relations };
	}

	// Decomposed path: save parent bundle + atomic children.
	const parent = await saveSingleThought(
		deps,
		input.content,
		{ ...input, type: input.type || "log" },
		knownPeople,
		source,
		{ is_bundle: true },
	);
	if (parent.kind === "duplicate") return parent;

	const children: { id: string; topic: string }[] = [];
	const allRelations: string[] = [];

	for (const item of atomicThoughts) {
		const child = await saveSingleThought(
			deps,
			item.content,
			{
				content: item.content,
				type: item.type,
				topics: [item.topic],
				category: input.category,
			},
			knownPeople,
			source,
			{ parent_id: parent.thought.id },
		);
		if (child.kind === "duplicate") continue; // children carry no source_id; defensive only

		children.push({ id: child.thought.id, topic: item.topic });

		if (input.source_ids?.length) {
			await insertSourceRelations(db, child.thought.id, input.source_ids);
		}

		const relations = await runCompoundingPipeline(deps, background, child, parent.thought.id);
		allRelations.push(...relations);
	}

	return { kind: "decomposed", parent: parent.thought, children, relations: allRelations };
}

export type SavedThought = {
	kind: "saved";
	thought: Thought;
	embedding: number[];
	personDefinitions: PersonDefinition[];
};

async function saveSingleThought(
	deps: EchoDeps,
	text: string,
	input: CaptureInput,
	knownPeople: PersonRecord[],
	source: string,
	placement: { is_bundle?: boolean; parent_id?: string } = {},
): Promise<SavedThought | { kind: "duplicate"; id: string; source_id: string }> {
	const { db, ai } = deps;
	const extracted = await extractMetadata(ai, text, knownPeople);

	const { metadata, columns, embeddingText, personDefinitions } = projectThought(
		text,
		extracted,
		input,
		source,
		{ ownerName: deps.ownerName },
	);

	// Embed enriched text so the vector encodes topics/category/people, not just content.
	const embedding = await ai.embed(embeddingText);

	const row: Record<string, unknown> = { content: text, embedding, metadata };

	// Insert maps the resolved columns; absent signals default to null.
	if (columns.due_at) row.due_at = columns.due_at;
	if (columns.recurrence) row.recurrence = columns.recurrence;
	if (columns.priority !== null) row.priority = columns.priority;
	row.category = columns.category;
	if (columns.expires_at) row.expires_at = columns.expires_at;
	if (columns.event_at) row.event_at = columns.event_at;
	if (placement.is_bundle) row.is_bundle = true;
	if (placement.parent_id) row.parent_id = placement.parent_id;
	if (input.source_id) row.source_id = input.source_id;
	if (input.source_kind) row.source_kind = input.source_kind;

	const { data, error } = await db.from("thoughts").insert(row).select(THOUGHT_COLUMNS).single();

	if (error) {
		// Race between idempotency check and insert — treat as duplicate.
		if (error.code === "23505" && input.source_id) {
			const { data: existing } = await db
				.from("thoughts")
				.select("id")
				.eq("source_id", input.source_id)
				.maybeSingle();
			return { kind: "duplicate", id: existing?.id ?? "", source_id: input.source_id };
		}
		throw new Error(`Failed to capture: ${error.message}`);
	}

	return {
		kind: "saved",
		thought: data as Thought,
		embedding,
		personDefinitions,
	};
}

async function insertSourceRelations(
	db: EchoDeps["db"],
	thoughtId: string,
	sourceIds: string[],
): Promise<void> {
	for (const sourceId of sourceIds) {
		await db.from("thought_relations").upsert(
			{
				source_id: thoughtId,
				target_id: sourceId,
				relation_type: "derives",
				confidence: 1.0,
				is_latest: true,
			},
			{ onConflict: "source_id,target_id,relation_type" },
		);
	}
}

export async function detectRelations(
	deps: EchoDeps,
	thoughtId: string,
	content: string,
	parentId?: string,
): Promise<string[]> {
	const { db, ai } = deps;
	try {
		const embedding = await ai.embed(content);
		const { data: matches } = await db.rpc("hybrid_search", {
			query_text: content,
			query_embedding: embedding,
			match_threshold: 0.65,
			match_count: 5,
			alpha: 0.7,
			filter: {},
		});

		if (!matches || matches.length === 0) return [];

		const candidates = matches.filter(
			(m: { id: string; parent_id?: string; is_bundle?: boolean }) =>
				m.id !== thoughtId && !m.is_bundle && (!parentId || m.parent_id !== parentId),
		);

		const summaries: string[] = [];

		for (const candidate of candidates.slice(0, 3)) {
			const result = await classifyRelation(ai, content, candidate.content);
			if (!result || result.relation === "unrelated") continue;

			await db.from("thought_relations").upsert(
				{
					source_id: thoughtId,
					target_id: candidate.id,
					relation_type: result.relation,
					confidence: result.confidence,
					is_latest: true,
				},
				{ onConflict: "source_id,target_id,relation_type" },
			);

			if (result.relation === "updates") {
				await db
					.from("thought_relations")
					.update({ is_latest: false })
					.eq("target_id", candidate.id)
					.eq("relation_type", "updates")
					.neq("source_id", thoughtId);
			}

			const preview =
				candidate.content.length > 60
					? `${candidate.content.substring(0, 60)}...`
					: candidate.content;
			summaries.push(`${result.relation} "${preview}" (${(result.confidence * 100).toFixed(0)}%)`);
		}

		return summaries;
	} catch (err) {
		console.error("Relation detection failed:", err);
		return [];
	}
}

/**
 * Compounding side effects after a thought is saved or rewritten: relation
 * detection is awaited (its summaries go into the confirmation); topic pages,
 * the entity graph, and person-definition upserts run in the background so a
 * failed compilation can never fail the write. Shared by the capture and
 * update workflows so every write path compounds the same way.
 */
export async function runCompoundingPipeline(
	deps: EchoDeps,
	background: (work: Promise<unknown>) => void,
	saved: SavedThought,
	parentId: string | undefined,
): Promise<string[]> {
	const { thought, embedding, personDefinitions } = saved;
	const metadata = (thought.metadata ?? {}) as Record<string, unknown>;
	const topics = Array.isArray(metadata.topics) ? (metadata.topics as string[]) : [];

	const relations = await detectRelations(deps, thought.id, thought.content, parentId);

	if (topics.length) {
		background(
			updateTopicPagesForThought(
				deps,
				thought.id,
				thought.content,
				embedding,
				thought.created_at,
				topics,
				metadata.memory_type as string | undefined,
			),
		);
	}

	const mentions = extractEntityMentions(metadata);
	if (mentions.length) {
		background(
			linkThoughtEntities(deps.db, thought.id, mentions).then((entityIds) =>
				updateEntityPagesForThought(deps, entityIds),
			),
		);
	}

	if (personDefinitions.length) {
		background(
			(async () => {
				for (const def of personDefinitions) {
					try {
						const { newAliases } = await upsertPerson(deps.db, def.canonical_name, def.role);
						for (const alias of newAliases) {
							await backfillPersonAlias(deps, alias, def.canonical_name).catch((e) =>
								console.error(`Backfill failed for alias "${alias}":`, e),
							);
						}
					} catch (e) {
						console.error(`Person upsert failed for "${def.canonical_name}":`, e);
					}
				}
			})(),
		);
	}

	return relations;
}

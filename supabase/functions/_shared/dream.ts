/**
 * The Dream workflow — the nightly routine that reads the day's Claude Code
 * / Grok session transcripts, compares them against the corpus, and emits a
 * numbered list of proposed memory changes with transcript quotes as
 * evidence. Nothing is ever deleted or rewritten without explicit approval:
 * `dream()` only reads (see the "zero writes" test), and `applyProposals` /
 * `rejectProposals` are the only functions that ever mutate state, always
 * against an explicit list of proposal numbers the Owner chose.
 *
 * Composes lintThoughts (duplicates/stale/contradictions) rather than
 * reimplementing any check, and grounds each transcript turn against the
 * existing corpus via searchThoughts before it ever reaches the classifier —
 * that grounding step is what makes `target_ids` real ids instead of
 * hallucinated ones, and it's also the main cost lever (only grounded or
 * correction-shaped turns reach the Haiku classifier).
 */

import {
	buildEmbeddingText,
	confirmDuplicateMerges,
	type DreamClassifyItem,
	type DuplicateCandidate,
	proposeMemoryChanges,
	type RawDreamProposal,
} from "./ai.ts";
import { captureThought } from "./capture.ts";
import type { EchoDeps } from "./deps.ts";
import { extractEntityMentions, linkThoughtEntities } from "./entities.ts";
import { recompileEntityPage } from "./entity-pages.ts";
import { type DuplicatePair, type LintCheck, type LintReport, lintThoughts } from "./lint.ts";
import type { ModelUsage } from "./model.ts";
import { estimateUsd } from "./relevance-gate.ts";
import { searchThoughts } from "./search.ts";
import { getCurrentThought, NON_BUNDLE_FILTER } from "./thoughts-store.ts";
import { recompileTopicPage } from "./topic-pages.ts";
import { updateThought } from "./update.ts";

export type DreamAction = "create" | "update" | "supersede" | "merge" | "expire";
// NOTE: there is deliberately no "delete" member. That absence is the structural
// enforcement of "never delete without approval". "expire" sets expires_at, which
// is reversible — hidden, not destroyed. Do not add a delete verb.

export type DreamProposal = {
	n: number; // 1-based, assigned ONLY after the final sort
	pid: string; // "dream:2026-08-04#3"
	category: "correction" | "preference" | "new_fact" | "stale" | "duplicate";
	action: DreamAction;
	target_ids: string[]; // [] for create
	proposed_content: string;
	evidence: {
		quote: string;
		session_id: string;
		turn_index: number;
		transcript_path: string;
		at: string;
	};
	confidence: number; // 0..1
	rationale: string;
	fingerprint: string; // stable hash of category + sorted target_ids + normalized content
	status: "pending" | "applied" | "rejected";
	resolution_note?: string;
};

export type DreamTurn = {
	sessionId: string;
	turnIndex: number;
	userMessage: string;
	assistantMessage: string;
	projectName?: string;
	at: string;
	transcriptPath: string;
};

export type DreamInput = {
	turns: DreamTurn[]; // already parsed + prefiltered by the caller
	window: { from: string; to: string };
	now?: Date;
	maxTurns?: number; // default 400, recency-ordered
	maxProposals?: number; // default 12
	checks?: LintCheck[]; // default ["stale", "duplicates"]
	suppressFingerprints?: Set<string>;
	onUsage?: (u: ModelUsage) => "continue" | "stop"; // budget seam
};

export type DreamResult = {
	proposals: DreamProposal[];
	scanned: { turns: number; sessions: number };
	usage: ModelUsage;
	health: { newest_capture_at: string | null; capture_pipeline_stale: boolean };
	truncated: boolean;
	/** Count of classifier proposals dropped because their echoed
	 * session_id/turn_index didn't resolve to a turn in the batch — see
	 * classifyTurns. Never stapled to a wrong turn as a fallback. */
	dropped: number;
	/** Count of findDuplicates candidate pairs that confirmDuplicateMerges did
	 * NOT confirm as the same fact (explicit same_fact: false, a parse/schema
	 * failure, or a missing verdict) — surfaced so the run log shows the gate
	 * rejecting false-positive merges, e.g. near-identical-looking records
	 * that are actually distinct entities. */
	duplicatesRejected: number;
	/** Threaded through from DreamInput so writeDreamReport doesn't need a
	 * fourth parameter to record the scan window in metadata.dream. */
	window: { from: string; to: string };
	/** The same clock dream() used to number proposals (pid embeds this
	 * date) — writeDreamReport must reuse it rather than calling `new Date()`
	 * again, or run_at could land on a different day than the pids if the
	 * write happens to straddle a midnight boundary. */
	now: Date;
};

export type DreamReportMetadata = {
	run_at: string;
	window: { from: string; to: string };
	scanned: { turns: number; sessions: number };
	cost_usd: number;
	/** Safe fixes (see SafeFix/applySafeFixes) auto-applied by the nightly job
	 * while writing this report — never a proposal number, since safe fixes
	 * never go through the propose/approve/apply loop. */
	auto_applied: AppliedFix[];
	proposals: DreamProposal[];
	health: { newest_capture_at: string | null; capture_pipeline_stale: boolean };
};

export type DreamReport = {
	id: string;
	source_id: string | null;
	content: string;
	created_at: string;
	metadata: Record<string, unknown> & { dream: DreamReportMetadata };
};

export type ApplyOutcome = {
	n: number;
	status: "applied" | "rejected" | "skipped" | "error";
	thoughtId?: string;
	error?: string;
};

/**
 * Maintenance chores the nightly job may apply on its own, with no Owner
 * approval loop — unlike DreamProposal, which always waits for
 * applyProposals/rejectProposals against an explicit list the Owner chose.
 * Each variant names exactly one derived, regenerable artifact to
 * recompute: an embedding vector, a compiled topic/entity page, or an
 * additive entity link. None of these can carry authored state (content,
 * due dates, priority, status) — see applySafeFixes.
 */
export type SafeFix =
	| { kind: "reembed"; thoughtId: string }
	| { kind: "recompile_topic_page"; slug: string }
	| { kind: "recompile_entity_page"; entityId: string }
	| { kind: "link_entities"; thoughtId: string };

export type AppliedFix = {
	fix: SafeFix;
	status: "applied" | "skipped" | "error";
	error?: string;
};

const DEFAULT_MAX_TURNS = 400;
const DEFAULT_MAX_PROPOSALS = 12;
const DEFAULT_CHECKS: LintCheck[] = ["stale", "duplicates"];
// Paired with proposeMemoryChanges' maxOutputTokens (ai.ts): halved from 8 so
// a full batch's worth of proposals comfortably fits in 4096 output tokens
// without truncating mid-string. Don't tune one without the other.
const CLASSIFY_BATCH_SIZE = 4;
const GROUNDING_LIMIT = 3;
const REPORT_TTL_DAYS = 14;
const HEALTH_STALE_MS = 48 * 60 * 60 * 1000;
const TRANSCRIPT_SOURCE_KINDS = ["claude-transcript", "claude-precompact", "grok-transcript"];

const CORRECTION_MARKERS =
	/\b(actually|correction|i was wrong|that'?s wrong|not\s+\w+,\s*it'?s|meant to say|to clarify|scratch that|instead of)\b/i;

function looksLikeCorrection(text: string): boolean {
	return CORRECTION_MARKERS.test(text);
}

function normalizeContent(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** djb2 — deterministic, dependency-free, good enough for a dedupe key
 * (not a security hash). Runtime-neutral, unlike node:crypto/Deno's crypto. */
function djb2(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = (h * 33) ^ s.charCodeAt(i);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function computeFingerprint(category: string, targetIds: string[], content: string): string {
	const key = `${category}|${[...targetIds].sort().join(",")}|${normalizeContent(content)}`;
	return djb2(key);
}

/** A proposal with n/pid not yet assigned — finalized only after the last
 * sort/cap step, since pid embeds the final rank. */
type DraftProposal = Omit<DreamProposal, "n" | "pid">;

async function probeHealth(deps: EchoDeps, now: Date): Promise<DreamResult["health"]> {
	const { data } = await deps.db
		.from("thoughts")
		.select("created_at")
		.in("source_kind", TRANSCRIPT_SOURCE_KINDS)
		.order("created_at", { ascending: false })
		.limit(1);
	const rows = (data ?? []) as { created_at: string }[];
	const newest = rows[0]?.created_at ?? null;
	const age = newest ? now.getTime() - new Date(newest).getTime() : Number.POSITIVE_INFINITY;
	return { newest_capture_at: newest, capture_pipeline_stale: age > HEALTH_STALE_MS };
}

type GroundedTurn = DreamTurn & { grounded: { id: string; content: string }[] };

/**
 * Grounds each turn against the existing corpus. Only turns with a grounded
 * hit or a correction-shaped user message go on to the classifier — this is
 * the cost lever the classify step relies on, and the grounded ids are the
 * only ids the classifier is allowed to target.
 */
async function groundTurns(deps: EchoDeps, turns: DreamTurn[]): Promise<GroundedTurn[]> {
	const out: GroundedTurn[] = [];
	for (const t of turns) {
		const query = `${t.userMessage}\n${t.assistantMessage}`.slice(0, 2000);
		let grounded: { id: string; content: string }[] = [];
		try {
			const { results } = await searchThoughts(deps, query, {
				limit: GROUNDING_LIMIT,
				includePages: false,
			});
			grounded = results.map((r) => ({ id: r.id, content: r.content }));
		} catch {
			grounded = [];
		}
		if (grounded.length > 0 || looksLikeCorrection(t.userMessage)) {
			out.push({ ...t, grounded });
		}
	}
	return out;
}

function rawToDraft(
	raw: RawDreamProposal,
	turn: DreamTurn,
	allowedIds: Set<string>,
): DraftProposal {
	// Defensive filter against hallucinated ids: only ids we actually offered
	// the classifier as grounded memories are trustworthy.
	const targetIds = raw.target_ids.filter((id) => allowedIds.has(id));
	return {
		category: raw.category,
		action: raw.action,
		target_ids: targetIds,
		proposed_content: raw.proposed_content,
		evidence: {
			quote: raw.quote,
			session_id: raw.session_id || turn.sessionId,
			turn_index: raw.turn_index ?? turn.turnIndex,
			transcript_path: turn.transcriptPath,
			at: turn.at,
		},
		confidence: raw.confidence,
		rationale: raw.rationale,
		fingerprint: computeFingerprint(raw.category, targetIds, raw.proposed_content),
		status: "pending",
	};
}

async function classifyTurns(
	deps: EchoDeps,
	groundedTurns: GroundedTurn[],
	onUsage: DreamInput["onUsage"],
): Promise<{ drafts: DraftProposal[]; usage: ModelUsage; truncated: boolean; dropped: number }> {
	const drafts: DraftProposal[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let truncated = false;
	let dropped = 0;

	for (let i = 0; i < groundedTurns.length; i += CLASSIFY_BATCH_SIZE) {
		const batch = groundedTurns.slice(i, i + CLASSIFY_BATCH_SIZE);
		const byKey = new Map<string, GroundedTurn>();
		const allowedIds = new Set<string>();
		const items: DreamClassifyItem[] = batch.map((t) => {
			byKey.set(`${t.sessionId}|${t.turnIndex}`, t);
			for (const g of t.grounded) allowedIds.add(g.id);
			return {
				sessionId: t.sessionId,
				turnIndex: t.turnIndex,
				userMessage: t.userMessage,
				assistantMessage: t.assistantMessage,
				at: t.at,
				groundedMemories: t.grounded,
			};
		});

		const { proposals, usage } = await proposeMemoryChanges(deps.ai, items);
		inputTokens += usage.inputTokens;
		outputTokens += usage.outputTokens;

		for (const raw of proposals) {
			// If the model echoes a session_id/turn_index that doesn't resolve to
			// a turn we actually sent it, do NOT fall back to batch[0] — that
			// would staple the proposal to whatever turn happens to be first,
			// producing an internally inconsistent citation (right session id,
			// wrong transcript_path/at). Evidence is the trust mechanism; drop
			// instead of guessing.
			const turn = byKey.get(`${raw.session_id}|${raw.turn_index}`);
			if (!turn) {
				dropped++;
				continue;
			}
			drafts.push(rawToDraft(raw, turn, allowedIds));
		}

		if (onUsage?.(usage) === "stop") {
			truncated = true;
			break;
		}
	}

	return { drafts, usage: { inputTokens, outputTokens }, truncated, dropped };
}

/** Maps lintThoughts findings onto the same proposal shape the classifier
 * produces: stale → expire, contradictions → supersede. Lint findings
 * originate from the existing corpus, not a transcript, so their "evidence"
 * is the corpus content itself rather than a session quote.
 *
 * Duplicates are deliberately NOT handled here. findDuplicates is a lint
 * heuristic for human eyeballing (its own MCP output says "delete one or
 * merge") — candidate generation, not a merge instruction. Two thoughts can
 * sit at 0.95+ cosine similarity while describing entirely different
 * entities/events (e.g. AC service records for different rooms), so turning
 * a duplicate pair straight into a pre-filled merge proposal risks silent
 * data loss. See confirmDuplicateProposals, which gates duplicate pairs
 * behind an LLM same-fact verdict before they become actionable. */
export function lintFindingsToProposals(
	report: LintReport,
	now: Date = new Date(),
): DreamProposal[] {
	const drafts: DraftProposal[] = [];

	for (const fact of report.stale ?? []) {
		const targetIds = [fact.id];
		// No new memory results from an expire — proposed_content carries the
		// target's existing content for display only. The apply path must
		// never capture this; expiring sets expires_at and writes nothing.
		const content = fact.content.trim();
		drafts.push({
			category: "stale",
			action: "expire",
			target_ids: targetIds,
			proposed_content: content,
			evidence: {
				quote: fact.content,
				session_id: "lint",
				turn_index: -1,
				transcript_path: "",
				at: fact.created_at,
			},
			confidence: 0.9,
			rationale: `Expire stale fact: "${content}" — every 'updates' relation pointing at this fact is superseded.`,
			fingerprint: computeFingerprint("stale", targetIds, content),
			status: "pending",
		});
	}

	for (const c of report.contradictions ?? []) {
		const targetIds = [c.thought_a, c.thought_b];
		// findContradictions only yields an explanation, not a resolved fact —
		// there is nothing safe to capture. Leave proposed_content empty so
		// applyProposals refuses this proposal with a loud error rather than
		// capturing the directive sentence as a memory.
		const content = "";
		drafts.push({
			category: "correction",
			action: "supersede",
			target_ids: targetIds,
			proposed_content: content,
			evidence: {
				quote: c.explanation,
				session_id: "lint",
				turn_index: -1,
				transcript_path: "",
				at: now.toISOString(),
			},
			confidence: 0.8,
			rationale: `Resolve contradiction: ${c.explanation}`,
			fingerprint: computeFingerprint("correction", targetIds, content),
			status: "pending",
		});
	}

	// Numbering is assigned by the caller (dream()'s finalize step) so that a
	// direct call to this pure mapper still returns something usable, we
	// finalize with a throwaway date/rank here.
	return finalizeProposals(drafts, now);
}

function finalizeProposals(drafts: DraftProposal[], now: Date): DreamProposal[] {
	const dateStr = now.toISOString().slice(0, 10);
	return drafts.map((d, i) => {
		const n = i + 1;
		return { ...d, n, pid: `dream:${dateStr}#${n}` };
	});
}

/** pair_id encoding for confirmDuplicateMerges candidates — stable and
 * reversible so a verdict can be re-associated with its originating pair
 * without trusting the model to echo target ids back correctly. */
function pairId(a: string, b: string): string {
	return `${a}|${b}`;
}

/**
 * Gates findDuplicates candidate pairs behind an LLM same-fact verdict
 * before any of them may become an actionable merge proposal — see the note
 * on lintFindingsToProposals for why this can't be a mechanical mapping.
 * Async (unlike lintFindingsToProposals), so it lives as its own step in
 * dream() rather than folded into the pure mapper. Fails closed end to end:
 * confirmDuplicateMerges itself never throws, and any pair without an
 * affirmative same_fact: true verdict (rejected, unparseable, or simply
 * missing from the response) is dropped, not merged.
 */
async function confirmDuplicateProposals(
	deps: EchoDeps,
	pairs: DuplicatePair[],
	now: Date,
	onUsage: DreamInput["onUsage"],
): Promise<{ drafts: DraftProposal[]; usage: ModelUsage; duplicatesRejected: number }> {
	if (!pairs.length)
		return { drafts: [], usage: { inputTokens: 0, outputTokens: 0 }, duplicatesRejected: 0 };

	const candidates: DuplicateCandidate[] = pairs.map((pair) => ({
		pair_id: pairId(pair.thought_a, pair.thought_b),
		content_a: pair.content_a.trim(),
		content_b: pair.content_b.trim(),
	}));

	const { verdicts, usage } = await confirmDuplicateMerges(deps.ai, candidates);
	onUsage?.(usage);

	const byPairId = new Map(verdicts.map((v) => [v.pair_id, v]));
	const drafts: DraftProposal[] = [];
	let duplicatesRejected = 0;

	for (const pair of pairs) {
		const verdict = byPairId.get(pairId(pair.thought_a, pair.thought_b));
		if (!verdict || !verdict.same_fact || !verdict.merged_content.trim()) {
			duplicatesRejected++;
			continue;
		}
		const targetIds = [pair.thought_a, pair.thought_b];
		const content = verdict.merged_content.trim();
		drafts.push({
			category: "duplicate",
			action: "merge",
			target_ids: targetIds,
			proposed_content: content,
			evidence: {
				quote: `${pair.content_a.trim()} / ${pair.content_b.trim()}`,
				session_id: "lint",
				turn_index: -1,
				transcript_path: "",
				at: now.toISOString(),
			},
			confidence: pair.similarity,
			rationale: verdict.reason || "Confirmed same fact by duplicate-merge review.",
			fingerprint: computeFingerprint("duplicate", targetIds, content),
			status: "pending",
		});
	}

	return { drafts, usage, duplicatesRejected };
}

/**
 * Reads the day's transcript turns and the existing corpus, and returns a
 * ranked, capped list of proposed memory changes. Never writes: no capture,
 * update, or resolve call reaches the database from this function.
 */
export async function dream(deps: EchoDeps, input: DreamInput): Promise<DreamResult> {
	const now = input.now ?? new Date();
	const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxProposals = input.maxProposals ?? DEFAULT_MAX_PROPOSALS;
	const checks = input.checks ?? DEFAULT_CHECKS;
	const suppress = input.suppressFingerprints ?? new Set<string>();

	const health = await probeHealth(deps, now);

	const sorted = [...input.turns].sort(
		(a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
	);
	const gathered = sorted.slice(0, maxTurns);
	const scanned = {
		turns: gathered.length,
		sessions: new Set(gathered.map((t) => t.sessionId)).size,
	};

	const groundedTurns = await groundTurns(deps, gathered);
	const {
		drafts: classifyDrafts,
		usage,
		truncated,
		dropped,
	} = await classifyTurns(deps, groundedTurns, input.onUsage);

	const lintReport = await lintThoughts(deps, { checks, maxItems: maxProposals });
	const lintDrafts: DraftProposal[] = lintFindingsToProposals(lintReport, now).map(
		({ n: _n, pid: _pid, ...rest }) => rest,
	);

	const {
		drafts: duplicateDrafts,
		usage: duplicateUsage,
		duplicatesRejected,
	} = await confirmDuplicateProposals(deps, lintReport.duplicates?.pairs ?? [], now, input.onUsage);
	const totalUsage: ModelUsage = {
		inputTokens: usage.inputTokens + duplicateUsage.inputTokens,
		outputTokens: usage.outputTokens + duplicateUsage.outputTokens,
	};

	const combined = [...classifyDrafts, ...lintDrafts, ...duplicateDrafts].filter(
		(d) => !suppress.has(d.fingerprint),
	);

	const byKey = new Map<string, DraftProposal>();
	for (const d of combined) {
		// create proposals have no target_ids, so category|target_ids would
		// collapse every distinct new fact into one key ("new_fact|") and only
		// the highest-confidence one would survive. Fall back to the
		// fingerprint (which folds in normalized content) so distinct creates
		// stay distinct; only real updates/merges/expires/supersedes — which do
		// have target_ids — dedupe on the target they point at.
		const key = d.target_ids.length
			? `${d.category}|${[...d.target_ids].sort().join(",")}`
			: d.fingerprint;
		const existing = byKey.get(key);
		if (!existing || d.confidence > existing.confidence) byKey.set(key, d);
	}

	const ranked = [...byKey.values()]
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, maxProposals);

	const proposals = finalizeProposals(ranked, now);

	return {
		proposals,
		scanned,
		usage: totalUsage,
		health,
		truncated,
		dropped,
		duplicatesRejected,
		window: input.window,
		now,
	};
}

/**
 * Writes the dream report row: a bundle thought (excluded from search,
 * listing, lint, and relation candidates by is_bundle) whose embedded
 * content is a deliberately bland anchor string, not the proposal text.
 * Idempotent on source_id, matching captureThought's convention.
 */
export async function writeDreamReport(
	deps: EchoDeps,
	r: DreamResult,
	sourceId: string,
	autoApplied: AppliedFix[] = [],
): Promise<{ id: string; duplicate: boolean }> {
	const { db, ai } = deps;

	const { data: existing } = await db.from("thoughts").select("id").eq("source_id", sourceId);
	const existingRows = (existing ?? []) as { id: string }[];
	if (existingRows.length > 0) {
		return { id: existingRows[0].id, duplicate: true };
	}

	const runAt = r.now;
	const anchor = `Echo dream report ${runAt.toISOString().slice(0, 10)}`;
	const embedding = await ai.embed(anchor);
	const expiresAt = new Date(runAt.getTime() + REPORT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const dreamMeta: DreamReportMetadata = {
		run_at: runAt.toISOString(),
		window: r.window,
		scanned: r.scanned,
		cost_usd: estimateUsd(r.usage.inputTokens, r.usage.outputTokens),
		auto_applied: autoApplied,
		proposals: r.proposals,
		health: r.health,
	};

	const { data, error } = await db
		.from("thoughts")
		.insert({
			content: anchor,
			embedding,
			metadata: { dream: dreamMeta, memory_type: "episodic", source: "dream" },
			is_bundle: true,
			source_id: sourceId,
			source_kind: "dream-report",
			expires_at: expiresAt,
		})
		.select("id")
		.single();

	if (error) throw new Error(`Failed to write dream report: ${error.message}`);
	return { id: (data as { id: string }).id, duplicate: false };
}

/**
 * Fetches a dream report by source_id, or the most recent one when omitted.
 * Queries `thoughts` directly rather than going through listThoughts:
 * NON_BUNDLE_FILTER is unconditional there, and dream reports are bundles.
 */
export async function getDreamReport(
	db: EchoDeps["db"],
	opts: { sourceId?: string } = {},
): Promise<DreamReport | null> {
	let q = db
		.from("thoughts")
		.select("id, content, source_id, metadata, created_at")
		.eq("source_kind", "dream-report");

	q = opts.sourceId
		? q.eq("source_id", opts.sourceId)
		: q.order("created_at", { ascending: false }).limit(1);

	const { data } = await q;
	const rows = (data ?? []) as {
		id: string;
		content: string;
		source_id: string | null;
		metadata: Record<string, unknown>;
		created_at: string;
	}[];
	const row = rows[0];
	if (!row) return null;
	// Consistent with the private getReport() below: never hand back a row
	// that lacks metadata.dream, even though source_kind already filtered to
	// "dream-report" rows.
	if (!row.metadata?.dream) return null;
	return row as DreamReport;
}

/**
 * Fingerprints of proposals rejected in dream reports written in the last
 * `days` days — passed back in as DreamInput.suppressFingerprints so a
 * rejected proposal doesn't get re-proposed on the next run.
 */
export async function listRecentFingerprints(
	db: EchoDeps["db"],
	days: number,
): Promise<Set<string>> {
	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
	const { data } = await db
		.from("thoughts")
		.select("metadata")
		.eq("source_kind", "dream-report")
		.gte("created_at", cutoff);

	const fingerprints = new Set<string>();
	for (const row of (data ?? []) as { metadata: Record<string, unknown> }[]) {
		const dreamMeta = row.metadata?.dream as DreamReportMetadata | undefined;
		for (const p of dreamMeta?.proposals ?? []) {
			if (p.status === "rejected") fingerprints.add(p.fingerprint);
		}
	}
	return fingerprints;
}

async function getReport(db: EchoDeps["db"], reportId: string): Promise<DreamReport> {
	const current = await getCurrentThought(db, reportId);
	if (!current) throw new Error(`Dream report not found: ${reportId}`);
	const metadata = (current.metadata ?? {}) as Record<string, unknown>;
	const dreamMeta = metadata.dream as DreamReportMetadata | undefined;
	if (!dreamMeta) throw new Error(`Thought ${reportId} is not a dream report`);
	return {
		id: current.id,
		source_id: null,
		content: current.content,
		created_at: current.created_at,
		metadata: metadata as DreamReport["metadata"],
	};
}

/**
 * Writes the whole rewritten metadata.dream object back through
 * updateThought — never a nested partial, since UpdateInput.metadata is a
 * shallow patch merged over current.metadata: passing {dream: {...partial}}
 * would silently drop every other proposal's status.
 */
async function persistDreamMeta(
	deps: EchoDeps,
	reportId: string,
	dreamMeta: DreamReportMetadata,
): Promise<void> {
	const result = await updateThought(deps, reportId, { metadata: { dream: dreamMeta } });
	if (result.kind === "not_found") throw new Error(`Dream report not found: ${reportId}`);
}

function resolveTargets(ns: number[] | "all", proposals: DreamProposal[]): number[] {
	if (ns === "all") return proposals.filter((p) => p.status === "pending").map((p) => p.n);
	return ns;
}

const ACTIONS_REQUIRING_CONTENT: DreamAction[] = ["create", "update", "supersede", "merge"];
const ACTIONS_REQUIRING_TARGETS: DreamAction[] = ["update", "supersede", "merge", "expire"];

/**
 * Sets expires_at on a thought — the strongest destructive verb this module
 * is allowed to use (see the DreamAction NOTE above: no delete). `expires_at`
 * is a real column, not metadata, so this can't go through updateThought's
 * metadata patch path; kept private to this module since nothing else needs
 * a bare expires_at write.
 */
async function expireThought(db: EchoDeps["db"], id: string, expiresAtIso: string): Promise<void> {
	const { error } = await db.from("thoughts").update({ expires_at: expiresAtIso }).eq("id", id);
	if (error) throw new Error(`Failed to expire thought ${id}: ${error.message}`);
}

/**
 * Applies a single proposal per its action. This is the only place any
 * proposal's action is interpreted — every branch either mutates exactly the
 * target(s) the proposal names, or refuses loudly. A capture only ever
 * happens for "create"; every other action mutates existing thoughts, and
 * "expire" never captures anything at all.
 */
async function applyOne(
	deps: EchoDeps,
	reportId: string,
	proposal: DreamProposal,
): Promise<ApplyOutcome> {
	const { n, action, target_ids: targetIds, proposed_content: content } = proposal;

	if (ACTIONS_REQUIRING_TARGETS.includes(action) && targetIds.length === 0) {
		return {
			n,
			status: "error",
			error: `action "${action}" requires target_ids but none were given`,
		};
	}
	if (ACTIONS_REQUIRING_CONTENT.includes(action) && !content.trim()) {
		return {
			n,
			status: "error",
			error: `action "${action}" requires proposed_content but it was empty`,
		};
	}

	try {
		switch (action) {
			case "create": {
				const result = await captureThought(deps, {
					content,
					source_ids: [reportId, ...targetIds],
				});
				const thoughtId =
					result.kind === "captured"
						? result.thought.id
						: result.kind === "decomposed"
							? result.parent.id
							: result.id;
				return { n, status: "applied", thoughtId };
			}
			case "update":
			case "supersede": {
				const result = await updateThought(deps, targetIds[0], { content });
				if (result.kind === "not_found") {
					return { n, status: "error", error: `target thought not found: ${targetIds[0]}` };
				}
				return { n, status: "applied", thoughtId: result.thought.id };
			}
			case "merge": {
				const [primary, ...rest] = targetIds;
				const result = await updateThought(deps, primary, { content });
				if (result.kind === "not_found") {
					return { n, status: "error", error: `target thought not found: ${primary}` };
				}
				const expiresAtIso = new Date().toISOString();
				for (const id of rest) {
					await expireThought(deps.db, id, expiresAtIso);
				}
				return { n, status: "applied", thoughtId: result.thought.id };
			}
			case "expire": {
				const expiresAtIso = new Date().toISOString();
				for (const id of targetIds) {
					await expireThought(deps.db, id, expiresAtIso);
				}
				// Nothing captured — expiring hides, it never creates a memory.
				return { n, status: "applied" };
			}
		}
	} catch (err) {
		return { n, status: "error", error: (err as Error).message };
	}
}

/**
 * The only function that ever mutates a thought on the strength of a
 * proposal: for each requested (pending) proposal number, applies it per
 * its action (see applyOne), then flips that proposal's status to "applied"
 * in the report's metadata.dream — but only when the mutation actually
 * succeeded, so a failed apply never gets silently marked done. `ns` is
 * always explicit — there is no "apply everything pending" default.
 */
export async function applyProposals(
	deps: EchoDeps,
	reportId: string,
	ns: number[] | "all",
): Promise<ApplyOutcome[]> {
	const report = await getReport(deps.db, reportId);
	const dreamMeta = report.metadata.dream;
	const targets = resolveTargets(ns, dreamMeta.proposals);

	const outcomes: ApplyOutcome[] = [];
	const byN = new Map(dreamMeta.proposals.map((p) => [p.n, p]));

	for (const n of targets) {
		const proposal = byN.get(n);
		if (!proposal) {
			outcomes.push({ n, status: "error", error: "no such proposal" });
			continue;
		}
		if (proposal.status !== "pending") {
			outcomes.push({ n, status: "skipped", error: `already ${proposal.status}` });
			continue;
		}
		const outcome = await applyOne(deps, reportId, proposal);
		if (outcome.status === "applied") proposal.status = "applied";
		outcomes.push(outcome);
	}

	await persistDreamMeta(deps, reportId, dreamMeta);
	return outcomes;
}

/**
 * Flips the requested (pending) proposals to "rejected" with an optional
 * note. Never writes a thought — rejection only ever touches the report's
 * own metadata.dream.
 */
export async function rejectProposals(
	deps: EchoDeps,
	reportId: string,
	ns: number[],
	note?: string,
): Promise<ApplyOutcome[]> {
	const report = await getReport(deps.db, reportId);
	const dreamMeta = report.metadata.dream;
	const byN = new Map(dreamMeta.proposals.map((p) => [p.n, p]));

	const outcomes: ApplyOutcome[] = [];
	for (const n of ns) {
		const proposal = byN.get(n);
		if (!proposal) {
			outcomes.push({ n, status: "error", error: "no such proposal" });
			continue;
		}
		if (proposal.status !== "pending") {
			outcomes.push({ n, status: "skipped", error: `already ${proposal.status}` });
			continue;
		}
		proposal.status = "rejected";
		if (note) proposal.resolution_note = note;
		outcomes.push({ n, status: "rejected" });
	}

	await persistDreamMeta(deps, reportId, dreamMeta);
	return outcomes;
}

/** Commit e63beee (2026-07-12) introduced the ADR-0021 owner-anchored embed
 * text (buildEmbeddingText prepends "About <Owner>: " to content before
 * embedding). Any thought last written before this cutoff still carries a
 * pre-anchor vector and retrieves worse than a fresh capture. Deliberately
 * NOT tracked via a metadata marker — metadata is off-limits for safe fixes
 * (see applySafeFixes) — so updated_at both selects the candidates and,
 * once applySafeFixes writes a fresh embedding (bumping updated_at), is what
 * makes an already-processed row fall out of the next night's selection. */
const OWNER_ANCHOR_CUTOFF = "2026-07-12T00:00:00Z";
const DEFAULT_MAX_REEMBEDS = 25;

/**
 * Selects safe-fix candidates. Only re-embeds are found today — recompiling
 * a specific topic/entity page or linking a specific thought's entities
 * needs a target already in hand (the capture pipeline itself schedules
 * those incrementally); this function's job is to find work nothing else
 * would ever revisit on its own, which for now is exactly the pre-ADR-0021
 * embedding backlog. Capped (default 25) to bound nightly embedding spend.
 */
export async function findSafeFixes(
	deps: EchoDeps,
	opts: { maxReembeds?: number } = {},
): Promise<SafeFix[]> {
	const maxReembeds = opts.maxReembeds ?? DEFAULT_MAX_REEMBEDS;
	if (maxReembeds <= 0) return [];

	const { data } = await deps.db
		.from("thoughts")
		.select("id")
		.or(NON_BUNDLE_FILTER)
		.lt("updated_at", OWNER_ANCHOR_CUTOFF)
		.order("updated_at", { ascending: true })
		.limit(maxReembeds);

	return ((data ?? []) as { id: string }[]).map((row) => ({ kind: "reembed", thoughtId: row.id }));
}

/**
 * Applies a batch of safe fixes — nightly maintenance the Owner never has to
 * approve. A closed switch over exactly SafeFix's four kinds: structurally,
 * this function cannot express any operation other than the four named here,
 * so it can never become a side door around the propose/approve/apply loop
 * DreamProposal enforces. The invariant every branch must hold: touch only
 * derived, regenerable data (an embedding vector, a compiled page, an
 * additive entity link) — NEVER content, metadata, due_at, priority, or
 * status, and NEVER a delete. (recompileEntityPage's own below-threshold
 * cleanup deletes a *page*, not a thought — out of scope for that rule.)
 */
export async function applySafeFixes(deps: EchoDeps, fixes: SafeFix[]): Promise<AppliedFix[]> {
	const { db, ai, ownerName } = deps;
	const outcomes: AppliedFix[] = [];

	for (const fix of fixes) {
		try {
			switch (fix.kind) {
				case "reembed": {
					const { data: row } = await db
						.from("thoughts")
						.select("id, content, metadata, category")
						.eq("id", fix.thoughtId)
						.single();
					if (!row) {
						outcomes.push({ fix, status: "skipped", error: "thought not found" });
						continue;
					}
					const thought = row as {
						content: string;
						metadata: Record<string, unknown> | null;
						category: string | null;
					};
					const text = buildEmbeddingText(
						thought.content,
						thought.metadata ?? {},
						thought.category,
						ownerName ?? null,
					);
					const embedding = await ai.embed(text);
					const { error } = await db
						.from("thoughts")
						.update({ embedding, updated_at: new Date().toISOString() })
						.eq("id", fix.thoughtId);
					if (error) throw new Error(error.message);
					outcomes.push({ fix, status: "applied" });
					break;
				}
				case "recompile_topic_page": {
					const { data: page } = await db
						.from("topic_pages")
						.select("id")
						.eq("slug", fix.slug)
						.single();
					if (!page) {
						outcomes.push({ fix, status: "skipped", error: "topic page not found" });
						continue;
					}
					await recompileTopicPage(deps, (page as { id: string }).id);
					outcomes.push({ fix, status: "applied" });
					break;
				}
				case "recompile_entity_page": {
					const result = await recompileEntityPage(deps, fix.entityId);
					if (!result) {
						outcomes.push({
							fix,
							status: "skipped",
							error: "entity not found or below the page threshold",
						});
						continue;
					}
					outcomes.push({ fix, status: "applied" });
					break;
				}
				case "link_entities": {
					const current = await getCurrentThought(db, fix.thoughtId);
					if (!current) {
						outcomes.push({ fix, status: "skipped", error: "thought not found" });
						continue;
					}
					const mentions = extractEntityMentions(current.metadata ?? {});
					if (!mentions.length) {
						outcomes.push({ fix, status: "skipped", error: "no entity mentions in metadata" });
						continue;
					}
					await linkThoughtEntities(db, fix.thoughtId, mentions);
					outcomes.push({ fix, status: "applied" });
					break;
				}
			}
		} catch (err) {
			outcomes.push({ fix, status: "error", error: (err as Error).message });
		}
	}

	return outcomes;
}

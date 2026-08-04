# Dream proposals are bundle rows awaiting approval

The nightly dream run writes exactly **one** `thoughts` row per night: `source_kind: "dream-report"`, `is_bundle: true`, `expires_at = run_at + 14 days`, with the numbered proposal list under `metadata.dream.proposals[]`. There is no `proposals` table, no `pending` member added to `ThoughtStatus`, and no row per proposal.

Proposals are never applied by the job that produced them. `dream()` is read-only; `applyProposals` and `rejectProposals` are the only functions that mutate a memory, and both require explicit proposal numbers — a value that can only originate from something the user typed.

## Why

**Why the `thoughts` table at all.** ADR-0009 forbids new tables for new kinds of data, and the queue genuinely belongs where the user reads. The failure being fixed was that Claude Desktop stopped capturing; a review queue on the local filesystem would be unreachable from exactly the surface that broke. A row in Postgres is reachable from Desktop, Grok web, mobile, and the dashboard.

**Why `is_bundle` rather than `expires_at` alone.** A proposal quotes the transcript evidence about a memory, so it is semantically adjacent to that memory and would rank high against the very queries the memory should answer. Expiry does not help during the 3am→9am review window, when the row is still live. Worse, routing a proposal through `captureThought` would run the compounding pipeline over it — writing relation edges, linking it to the Owner, and recompiling topic pages to include proposal text.

`is_bundle` is already excluded from every read path in the system, so it costs no new machinery:

| Read path | Exclusion |
|---|---|
| `_shared/search.ts` | `applyDecay(raw.filter((t) => !t.is_bundle))` |
| `listThoughts`, all four lint checks | `NON_BUNDLE_FILTER` in `_shared/thoughts-store.ts` |
| Relation candidates | `_shared/capture.ts` filters bundles |
| Topic page compilation | `.eq("is_bundle", false)` in `_shared/topic-pages.ts` |

`expires_at` is the second layer, enforced in SQL by `hybrid_search`. ADR-0002's 30-day compaction bookmarks are the standing precedent for operational rows living in `thoughts` with an expiry.

**Why one row per night.** The numbers the user types must mean the same thing at 9am that they meant at 3am. With one row, the list is immutable content authored once and `1,3` indexes `metadata.dream.proposals[]` directly. With a row per proposal, numbering would depend on a query whose ordering could shift between the write and the apply — and it would multiply the containment surface by the proposal count.

## Consequences

- The report is invisible to `search_thoughts` and `list_thoughts` by design, so `dream.ts` owns its own reader. Do **not** add `sourceKind` to `ThoughtListFilters`: `NON_BUNDLE_FILTER` is unconditional, so the filter would return nothing anyway. One caller is a hypothetical seam, not a real one.
- `dream_review` and `dream_apply` are the only MCP path to a report. That is the point — it is what makes reviewing from Desktop and Grok work.
- Status lives at `metadata.dream.proposals[].status` (`pending` / `applied` / `rejected`). Flipping it must rewrite the entire `dream` object: `UpdateInput.metadata` is a shallow patch merged last.
- Unreviewed proposals vanish after 14 days. That is intentional, but each report should report how many expired unreviewed so the loss is visible.

## `DreamAction` has no delete verb

```ts
export type DreamAction = "create" | "update" | "supersede" | "merge" | "expire";
```

The absence of `"delete"` is the enforcement of "never delete without approval" — not a prompt instruction the model could talk itself out of. `expire` sets `expires_at`, which hides a memory from search while leaving it recoverable. Nothing in the dream path calls `db.from("thoughts").delete()`.

Each action must do what its name says. An earlier revision funnelled every action into `captureThought`, which left `expire`, `merge` and `supersede` as no-ops against their targets while inserting the proposal's own directive string as a live, embedded memory — which the next night's lint would then flag as a duplicate of itself. Actions requiring content fail loudly when it is empty rather than capturing a placeholder.

## Duplicate merges require an affirmative verdict

`findDuplicates` is candidate generation, not a merge instruction. Its 0.95-cosine net is tuned for the `lint_thoughts` tool, where a human reads the output and its own suggested action is "delete one or merge".

Feeding that net straight into actionable proposals produced five destructive false positives in the first real run: distinct air-conditioner service records — different units, dates and costs, identical sentence structure — sat at 0.95–0.97 similarity, and the merge content was mechanically the longer of the two strings. Applying one would have overwritten one unit's record and expired the other.

So duplicate pairs now pass through `confirmDuplicateMerges`, which must affirmatively find that the pair records the same entity/event, and which authors the merged text itself rather than electing a survivor. Uncertainty resolves to "not a duplicate": a false negative costs one night, a false positive destroys a record. The `lint.ts` threshold is deliberately unchanged — a loose net plus human eyes remains right for the lint tool.

The general rule: **a heuristic good enough for a human to eyeball is not automatically good enough to pre-fill a destructive action.**

## Auto-applied fixes touch only regenerable data

`applySafeFixes` is a closed switch over four kinds — re-embed, recompile topic page, recompile entity page, backfill entity links. It structurally cannot express anything else, and may never modify `content`, `metadata`, `due_at`, `priority` or `status`. These rebuild derived data that is recomputable from the thoughts themselves, which is why they need no approval; every change to an authored memory remains proposal-only.

Deliberately excluded: auto-resolving a task whose completion appears in a transcript. `resolveThought` on a recurring thought archives a version *and* advances `due_at`, so a false positive silently drops a real task with no signal.

## Ingestion scope is an allow-root

`INGEST_ROOTS` admits `/Volumes/stuff/renan/` only, replacing the former per-project allowlist in `scripts/mine-claude-transcripts.allowlist.ts`.

The machine also runs Cursor for employer work at `/Volumes/stuff/lss`, `/Volumes/stuff/members` and `/Volumes/stuff/engines.code-workspace` — siblings of `renan/`, not children. Claude Code can run inside Cursor and would write those sessions into the same `~/.claude/projects/` tree. An allowlist requires remembering to exclude each new employer repository; an allow-root excludes them by default while covering new personal projects with no edit. It keeps the allowlist's paper-trail property: the roots are still a committed constant with no runtime escape hatch.

The guard runs in the scanner **before any file content is read**, `realpath`s first so a symlink or `../` cannot smuggle a path through, and fails closed when a session's cwd cannot be determined. Home-directory sessions are excluded as ambiguous.

If personal projects ever move out of `/Volumes/stuff/renan/`, or an employer repository is placed inside it, this guard silently inverts. That is the one assumption worth re-checking before relocating either.

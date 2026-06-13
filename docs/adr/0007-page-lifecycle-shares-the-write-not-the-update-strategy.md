# The page lifecycle shares the write invariant, not the update strategy

`_shared/page-lifecycle.ts` (`writeCompiledPage`) owns what topic pages and entity pages do *identically*: compile a summary, embed it as `"title\n\nsummary"` (the form the `search_*_pages` RPCs match against), and upsert the row with `thought_ids` plus a `thought_count` derived from them. Topic and entity pages are its two adapters. What stays in the adapters is what genuinely differs: topic pages match by slug/embedding and apply **incremental** updates (existing summary + the one new thought); entity pages resolve sources from graph links and always **fully recompile**, deleting the page when an entity drops below the threshold.

## Why

Two real adapters justify the seam — but only for the write. The update *strategy* diverges for good reasons (topic summaries accrete cheaply; entity summaries are small and recompile cleanly with their co-occurrence edges), so folding it into the shared module would mean a flag-driven branch that serves neither path well.

## Consequences

- A future review will see two `update*PagesForThought` functions and suggest merging them entirely. This ADR is the standing answer: the shared part is already extracted; the rest is intentionally adapter-specific.
- `writeCompiledPage` **throws** on write failure. Callers decide how to absorb it — the capture-pipeline callers are fire-and-forget and swallow it; this also surfaced entity-page write errors that were previously silently dropped.

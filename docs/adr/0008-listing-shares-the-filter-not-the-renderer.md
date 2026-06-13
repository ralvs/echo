# Thought listing shares the filter interface, not the renderer

`_shared/list-thoughts.ts` (`listThoughts`) owns the query shape every listing caller needs: the JSONB metadata filters, column filters, time windows, sort orders, and the always-on bundle exclusion. `list_thoughts`, `list_due`, and the REST `GET /api/thoughts` pass a `ThoughtListFilters` object and render the rows themselves. The row-to-text formatting is deliberately **not** shared.

## Why this is recorded

Extracting the filter chain is obvious DRY; the explicit *no* is the part worth recording. Having pulled the query into one module, the natural next move is to also share a "format a thought" function — but the three callers present genuinely different surfaces: `list_thoughts` emits a numbered multi-line block with topic/project/sentiment tags, `list_due` emits a due-date line with a content preview, and `/api/thoughts` returns raw JSON for the dashboard to render. A shared renderer would collapse three intended presentations into one and immediately need per-caller flags.

So the seam sits at the filter, not the presentation. Adding a filter is one edit in `listThoughts` and one test; changing how a tool *displays* results stays local to that tool. Don't re-suggest a shared formatter.

# The search read path is one shared module with owned tuning knobs

`_shared/search.ts` (`searchThoughts`) is the single implementation of the read path: embedding, the `hybrid_search` RPC, bundle exclusion, memory-decay scoring, parent-context injection, and the topic/entity page preambles. The MCP `search_thoughts` tool and the REST `POST /api/search` route are formatting adapters over it — they choose text vs. JSON and nothing else. The blend and thresholds live in one `SEARCH_TUNING` constant inside the module, not at the call sites.

## Why this is recorded

Before this, the MCP tool carried the full enrichment while `/api/search` was a divergent sibling that silently lacked preambles and parent context, and `alpha`/threshold values were hardcoded at every caller. Two facts will surprise a future reader:

- **`/api/search` now returns `{ results, pages }`, not a bare array.** The dashboard consumes `.results`. This shape is deliberate so the REST path serves the same page preambles the MCP tool does; don't revert it to a flat array.
- **Page matching uses `0.5`, relation detection still uses `0.65`** (`capture.ts`). These are different jobs — surfacing context for a reader vs. gating graph-edge creation — so they are intentionally *not* unified into `SEARCH_TUNING`. Tune search knobs in `search.ts`; leave the relation-detection threshold where it is (see the relation-threshold rationale in the README decisions log).

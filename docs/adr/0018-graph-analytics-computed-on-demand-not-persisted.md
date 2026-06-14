# Graph analytics are computed on demand, not persisted

Communities, centrality, bridges, and paths are derived on each call from the live `entities` + `entity_edges` tables — `entityGraph(db)` reads the graph, the pure functions in graph-analysis.ts compute over it, the `find_path` / `graph_overview` tools render the result. Nothing is stored: no `community_id` column on `entities`, no precomputed centrality, no graph-snapshot table. No migration ships with this feature at all.

## Why this is recorded

- **Derived analytics over a small graph never need a cache.** A personal knowledge graph is hundreds of nodes; label propagation, weighted degree, and cross-community edges over it are sub-millisecond. Persisting them buys nothing and costs correctness — a stored `community_id` is wrong the instant the next capture adds a co-occurrence edge, and now needs a refresh path, a staleness story, and a fire-and-forget hook. This is the same call ADR-0009 makes for the schema ("promote a field only when indexed querying demands it") and the framing entity-pages.ts uses ("the SQL tables remain the single source of truth"): the analytics are a *view*, recomputed, never authoritative.
- **The tool stays pure on the `db` seam, by design.** `graph_overview` takes a graph and renders text; it does not call `ai`. The LLM-flavoured part of graphify's GRAPH_REPORT — narrating the surprising connections, proposing questions to reflect on — is a *renderer* concern and lives in the `graph-tour` skill, which orchestrates `graph_overview` and reasons over its output. The model running the skill is the LLM; plumbing `ai.generate` into the tool would only make it non-deterministic and harder to test (the same line lint.ts draws, where only the genuinely-LLM check takes `ai`). Pure tool for the facts, skill for the reflection.

## Consequences

- The whole feature is `_shared` + adapters with zero schema risk and full unit-test coverage of the logic.
- **When persistence becomes justified, the trigger is named:** the dashboard entity-graph view recomputes communities + centrality over the whole graph on every page load, and once the graph grows past ~1–2k nodes that recompute adds perceptible latency. *Then* the right shape is not columns on `entities` but a single regenerable `graph_snapshot` artifact — refreshed fire-and-forget after capture, deleted-and-rebuilt like an entity page, never authoritative — so the "generated artifact" framing carries over intact. Until that latency is real, on demand wins.
- `graph_overview` accepts a `min_weight` floor to shed incidental single-co-occurrence ties; it is a query knob, not stored state.

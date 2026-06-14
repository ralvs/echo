# The thought-relations graph is one shared module with two renderers

`_shared/relation-graph.ts` is the single implementation of projecting `thought_relations` into a node/edge view: `egoGraph(id, depth)` for the neighbourhood around one thought and `corpusGraph(limit)` for the whole graph, each returning `{ nodes, edges }` with dangling edges (endpoints not in the node set) dropped. The dashboard `GET /api/graph` route renders that to the `{ nodes, links }` JSON the D3 view wants; the `get_thought_context` MCP tool renders the same `egoGraph` to text for the LLM. This is an instance of ADR-0010 — the route used to hold the traversal inline.

## Why this is recorded

The traversal — fetch the relations touching a set, collect the neighbours, fetch their thoughts, drop edges whose endpoints aren't present — was written three times: twice inside the graph route (its whole-corpus branch and its ego branch, with the node/link projection copy-pasted) and once in the tool. Two facts will surprise a future reader:

- **`egoGraph` carries a `latestOnly` flag, not a fixed policy.** The dashboard passes `latestOnly: true` (superseded relations are noise in the picture); the context tool leaves it false and *keeps* superseded edges so it can tag them `(superseded)`. The two callers genuinely want different relation sets from the same traversal, so the difference is a parameter, not a fork.
- **Edges are returned as one deduped, depth-agnostic list.** The tool re-derives its two sections — "Relations" (edges touching the centre) and "Extended relations" (edges between neighbours) — by partitioning that list, rather than the module returning pre-split depth-1/depth-2 buckets. Keep the graph model neutral; let the renderer slice it.

## Consequences

- Adding a field the graph exposes (e.g. another node column) is one edit in `NODE_COLUMNS` and the `GraphNode` type; the two renderers pick up what they need.
- The route's `{ nodes, links }` JSON shape and the tool's text are deliberately *not* shared — same discipline as ADR-0008 (share the query, not the renderer). Don't suggest a shared formatter.

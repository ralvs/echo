# Thought stats are computed by the `get_thought_stats` RPC, not in-memory

`_shared/stats.ts` types the `get_thought_stats` SQL RPC as the single implementation of thought statistics; the MCP tool and the REST `/api/stats` route are formatting adapters over it. The MCP tool previously aggregated types/topics/people/overdue in JavaScript by scanning every thought — that path silently disagreed with the RPC (it counted person *aliases* the RPC resolves to canonical names via the `people` table) and has been deleted.

## Why

Aggregation rules are a single source of truth or they drift. SQL does the grouping efficiently and resolves people correctly; duplicating it in application code bought nothing and produced two different answers to "how many people have I mentioned." Keep aggregation in the RPC — do not re-introduce in-memory counting in the tool for the sake of "flexibility."

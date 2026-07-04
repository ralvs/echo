# Echo

Personal knowledge-capture system: thoughts go in through capture surfaces
(MCP tools, dashboard, transcript hooks), get enriched (embeddings, entities,
relations), and come back out through retrieval and visualization.

## Language

**Owner**:
The single Supabase Auth user Echo trusts, on every transport (MCP OAuth,
dashboard session). Identified by `ECHO_OWNER_USER_ID`.
_Avoid_: admin, the user, account

**Thought**:
One captured unit of knowledge (note, task, decision, observation…) with
JSONB metadata. The only write model — everything else is derived.

**Entity**:
A person, project, organization, tool, or place extracted from thoughts;
nodes of the co-occurrence graph.

**Community**:
A cluster of entities computed on demand from the co-occurrence graph
(ADR-0018); called "cluster" in the dashboard UI.

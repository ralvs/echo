# Everything is one `thoughts` table with JSONB metadata

All captured knowledge lives in a single `thoughts` table. There are no type-specific extension tables and no classification/fan-out routing. Flexible attributes (type, topics, people, action_items, status, memory_type, …) live in a GIN-indexed JSONB `metadata` column; only fields that need efficient range queries or sorting are promoted to real columns (`due_at`, `priority`, `category`, `parent_id`, `is_bundle`, `expires_at`, `event_at`).

## Why

Extension tables solve fragmentation — and there is none to solve here. A normalized per-type schema would buy classification routing, dedup, and bidirectional sync, all cost with no benefit for a personal knowledge base. JSONB + GIN + pgvector gives flexible querying without that machinery.

## Consequences

- Adding a new kind of data means enriching the extraction prompt, **not** creating a table. Promote a field to a real column only when it needs indexed sorting/ranging.
- A future reviewer will propose normalizing into per-type tables. This ADR is the standing answer: don't, unless a concrete need for cross-row integrity or fan-out actually appears.
- `topic_pages` and `entity_pages` are deliberate exceptions — they are system-generated compilations, not thoughts, and kept separate so they never have to be filtered out of every thought query (see the README decisions log).

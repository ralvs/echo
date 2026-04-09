# Echo

A personal knowledge capture system. Thoughts go in, get tagged and embedded by AI, and become searchable — from a dashboard or directly via Claude through an MCP server.

## What it does

- **Capture** text thoughts; AI extracts type, topics, people, action items, priority, dates, memory type, and temporal anchors
- **Search** using hybrid semantic + full-text search (pgvector + tsvector) with memory-aware relevance decay
- **Schedule** tasks with due dates, priorities, and recurrence rules
- **Decompose** multi-topic inputs into atomic thoughts automatically, with parent context injected in search results
- **Classify** memories as fact, preference, episodic, or procedural — each decays differently in search ranking
- **Relate** thoughts automatically via a knowledge graph (updates, extends, derives, related)
- **Profile** synthesize a structured user profile from captured knowledge (static facts + dynamic activity)
- **Version** every thought update; history archived in `thought_versions`
- **MCP server** exposes 10 tools so Claude can read, write, and reason about thoughts directly

## Architecture

### Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router) + TypeScript |
| Backend / DB | Supabase (PostgreSQL + pgvector) |
| Edge functions | Deno (Supabase Edge Functions) |
| Embeddings | OpenRouter → OpenAI `text-embedding-3-small` |
| Metadata extraction | OpenRouter → Claude Haiku 4.5 |
| Styling | Tailwind CSS 4 |
| State | Zustand |
| Linting / formatting | Biome |

### Single-table design

Everything lives in one `thoughts` table. No type-specific extension tables, no fan-out routing.

**Real columns** (for efficient sorting/indexing): `due_at`, `priority` (0–4), `category`, `parent_id`, `is_bundle`, `expires_at`, `event_at`

**JSONB `metadata`** (flexible, GIN-indexed): type, topics, people, action_items, dates_mentioned, source, status, resolved_at, location, cost, url, rating, last_completed, completion_count, memory_type

**JSONB `recurrence`**: interval_days, unit, days_of_week, day_of_month, end_at

**Why single table:** Extension tables solve fragmentation that doesn't exist here. JSONB + GIN + pgvector gives flexible querying without the complexity of classification routing, dedup, and bidirectional sync. When adding new data kinds: enrich the metadata extraction prompt, or add a real column only if it needs efficient sorting/indexing. Don't create new tables.

### Hybrid search

`hybrid_search` RPC blends **70% vector similarity** (pgvector cosine) + **30% full-text rank** (tsvector). A thought matches if either similarity exceeds threshold or a full-text match exists. A `search_vector` column is maintained by trigger on `content`, topics, and category. Expired thoughts (`expires_at < now()`) are filtered at the DB level.

Embeddings are enriched before indexing: topics, category, and type are appended to the content so semantic similarity captures metadata concepts.

### Memory classification and relevance decay

Every thought is classified into a memory type by the LLM:

| Type | Decay | Example |
|---|---|---|
| **fact** | None (1.0) | "My email is x@x.com" |
| **procedural** | None (1.0) | "To reset the router, hold the button for 10s" |
| **preference** | Slow (−2%/month, floor 0.7) | "I prefer dark mode" |
| **episodic** | Fast (−5%/month, floor 0.5) | "Had lunch with Sarah today" |

Decay is applied post-query as a multiplier on similarity scores, so older episodic memories naturally rank below equally-relevant facts.

Thoughts with a natural expiration (e.g. "dentist appointment next Monday") get an `expires_at` timestamp and are excluded from search after that date.

### Temporal grounding

Dual-layer timestamping separates _when captured_ (`created_at`) from _when it happened_ (`event_at`). This enables accurate temporal queries — "Last Tuesday I had lunch with Sarah" captured on Friday stores Tuesday as `event_at`, not Friday.

### Knowledge graph

When a new thought is captured, it's compared against existing thoughts (similarity threshold ≥ 0.8). High-similarity matches are classified by the LLM into relation types:

- **updates** — new thought contradicts/replaces old (marks previous as superseded via `is_latest = false`)
- **extends** — new thought adds detail without replacing
- **derives** — logical consequence of an existing thought
- **related** — topically connected but independent

Relations are stored in a `thought_relations` table and traversable via the `get_thought_context` tool.

### Decomposition

When a capture is long or covers multiple topics, the LLM automatically splits it into atomic thoughts. The original becomes a parent bundle (`is_bundle = true`) and is excluded from search results. Child thoughts reference it via `parent_id`.

When a decomposed child appears in search results, the parent bundle's content is fetched and included as "Original context" — giving the LLM the full picture without sacrificing atomic precision.

### Versioning and recurrence

Every `update_thought` call archives the current version to `thought_versions` before writing new content.

For recurring tasks: resolving a thought archives the current version, advances `due_at` to the next occurrence, and resets status to open. `last_completed` and `completion_count` are tracked in metadata.

---

## MCP Server

The `echo-mcp` edge function implements an MCP (Model Context Protocol) server — add it to Claude's config and Claude can capture, search, and manage thoughts directly.

### Auth

The MCP endpoint uses `verify_jwt = false` (Supabase gateway-level MCP auth isn't available yet). Auth is handled in the Hono middleware: the request must include `Authorization: Bearer <token>` where the token matches the `MCP_PUBLISHABLE_KEY` secret set on the edge function.

The Supabase service role key is used internally for DB access and is never exposed in client config.

### Available tools

| Tool | Description |
|---|---|
| `capture_thought` | Save a new thought; extracts metadata, detects relations, supports decomposition |
| `search_thoughts` | Semantic hybrid search with decay-adjusted scores and parent context injection |
| `list_thoughts` | Filtered listing with sorting by date, due date, or priority |
| `list_due` | Show overdue and upcoming tasks |
| `update_thought` | Modify content/metadata; archives previous version |
| `resolve_thought` | Mark done (or reopen); for recurring: advances due date |
| `delete_thought` | Permanently delete with cascade to versions |
| `thought_stats` | Summary statistics |
| `get_thought_context` | Traverse the knowledge graph — show a thought and all its relations (depth 1–2) |
| `get_profile` | Synthesize a structured user profile (static facts/preferences + dynamic activity) |

### Claude Code config

```json
{
  "mcpServers": {
    "echo": {
      "type": "http",
      "url": "https://<project-ref>.supabase.co/functions/v1/echo-mcp",
      "headers": {
        "Authorization": "Bearer <MCP_PUBLISHABLE_KEY>"
      }
    }
  }
}
```

---

## Project structure

```
echo/
├── app/
│   ├── api/
│   │   ├── thoughts/       # CRUD
│   │   ├── search/         # Hybrid search endpoint
│   │   └── stats/          # Dashboard stats
│   ├── capture/page.tsx
│   ├── thoughts/[id]/page.tsx
│   └── page.tsx            # Dashboard
├── components/
├── lib/
│   ├── ai.ts               # OpenRouter calls (metadata + embeddings)
│   ├── types.ts
│   ├── supabase.ts
│   └── store.ts            # Zustand store
└── supabase/
    ├── functions/
    └── functions/
        └── echo-mcp/
            ├── index.ts        # Hono app + MCP server factory
            ├── config.ts
            ├── ai.ts           # LLM calls (metadata, embeddings, relation classification)
            ├── decompose.ts    # Decomposition logic
            ├── recurrence.ts   # Recurrence advancement
            └── tools/          # One file per MCP tool (10 tools)
```

---

## Setup

### Prerequisites

- Node.js / Bun
- Supabase CLI (`brew install supabase/tap/supabase`)
- Docker (for local Supabase)

### Environment variables

Create `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
OPENROUTER_API_KEY=<openrouter-key>
```

Edge function secrets (set via Supabase dashboard or CLI):

```
MCP_PUBLISHABLE_KEY=<generate a random string — this is the bearer token for MCP>
MCP_ACCESS_KEY=<access key for reembed-thoughts function>
OPENROUTER_API_KEY=<same key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

### Local development

```bash
bun install

# Start local Supabase (Docker required)
supabase start

# Apply migrations
supabase db push

# Start Next.js
bun dev
```

### Deploy

```bash
# Deploy edge function
supabase functions deploy echo-mcp

# Set secrets
supabase secrets set MCP_PUBLISHABLE_KEY=<value>
supabase secrets set OPENROUTER_API_KEY=<value>
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<value>

# Deploy frontend to Vercel
vercel --prod
```

---

## Key decisions log

| Decision | Why |
|---|---|
| Single `thoughts` table with JSONB metadata | No fragmentation to solve; avoids fan-out routing complexity |
| Real columns for `due_at`, `priority`, `category` | Need efficient range queries and sorting; JSONB can't be indexed the same way |
| Bearer token auth on MCP (not Supabase JWT) | Supabase gateway doesn't support MCP-level JWT auth yet; publishable key is simpler and sufficient for personal use |
| `verify_jwt = false` in config.toml | Required because the MCP client sends a custom Bearer token, not a Supabase JWT |
| Metadata extraction parallel to embedding | Both are independent LLM calls — running in parallel cuts capture latency in half |
| Enriched embeddings (content + topics/category appended) | Semantic search matches on metadata concepts, not just raw text |
| Bundles excluded from search | Parent bundles are containers; searching them would return duplicate/redundant results |
| Resolve-and-advance for recurrence | Simpler than a scheduler; recurring tasks self-propagate on completion |
| Memory-type decay applied post-query | Keeps the DB function simple; decay logic is easy to tune in application code |
| `event_at` as real column (not JSONB) | Enables efficient temporal range queries and sorting |
| Relation detection threshold ≥ 0.8 | High bar before triggering LLM classification avoids false positives and unnecessary API calls |
| `is_latest` flag on relations | Supermemory's pattern — cleaner than `superseded_by` in metadata for tracking update chains |

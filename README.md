# Echo

A personal knowledge capture system. Thoughts go in, get tagged and embedded by AI, and become searchable — from a dashboard or directly via Claude through an MCP server.

## What it does

- **Capture** text thoughts; AI extracts type, topics, people, action items, priority, dates
- **Search** using hybrid semantic + full-text search (pgvector + tsvector)
- **Schedule** tasks with due dates, priorities, and recurrence rules
- **Decompose** multi-topic inputs into atomic thoughts automatically
- **Version** every thought update; history archived in `thought_versions`
- **MCP server** exposes 8 tools so Claude can read and write thoughts directly

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

**Real columns** (for efficient sorting/indexing): `due_at`, `priority` (0–4), `category`, `parent_id`, `is_bundle`

**JSONB `metadata`** (flexible, GIN-indexed): type, topics, people, action_items, dates_mentioned, source, status, resolved_at, location, cost, url, rating, last_completed, completion_count

**JSONB `recurrence`**: interval_days, unit, days_of_week, day_of_month, end_at

**Why single table:** Extension tables solve fragmentation that doesn't exist here. JSONB + GIN + pgvector gives flexible querying without the complexity of classification routing, dedup, and bidirectional sync. When adding new data kinds: enrich the metadata extraction prompt, or add a real column only if it needs efficient sorting/indexing. Don't create new tables.

### Hybrid search

`hybrid_search` RPC blends **70% vector similarity** (pgvector cosine) + **30% full-text rank** (tsvector). A thought matches if either similarity exceeds threshold or a full-text match exists. A `search_vector` column is maintained by trigger on `content`, topics, and category.

Embeddings are enriched before indexing: topics, category, and type are appended to the content so semantic similarity captures metadata concepts.

### Decomposition

When a capture is long or covers multiple topics, the LLM automatically splits it into atomic thoughts. The original becomes a parent bundle (`is_bundle = true`) and is excluded from search results. Child thoughts reference it via `parent_id`.

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
| `capture_thought` | Save a new thought; supports metadata overrides and decomposition |
| `search_thoughts` | Semantic hybrid search with similarity scores |
| `list_thoughts` | Filtered listing with sorting |
| `list_due` | Show overdue and upcoming tasks |
| `update_thought` | Modify content/metadata; archives previous version |
| `resolve_thought` | Mark done (or reopen); for recurring: advances due date |
| `delete_thought` | Permanently delete with cascade to versions |
| `thought_stats` | Summary statistics |

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
    │   ├── echo-mcp/
    │   │   ├── index.ts        # Hono app + MCP server factory
    │   │   ├── config.ts
    │   │   ├── ai.ts           # LLM calls
    │   │   ├── decompose.ts    # Decomposition logic
    │   │   ├── recurrence.ts   # Recurrence advancement
    │   │   └── tools/          # One file per MCP tool
    │   └── reembed-thoughts/   # Batch re-embedding utility
    └── migrations/
        ├── 00002_add_versioning.sql
        ├── 00003_add_scheduling.sql
        ├── 00004_add_decomposition.sql
        ├── 00005_enable_rls_thought_versions.sql
        ├── 00006_fix_function_search_paths.sql
        └── 00008_add_hybrid_search.sql
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

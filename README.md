# Echo

A personal knowledge capture system. Thoughts go in, get tagged and embedded by AI, and become searchable — from a dashboard or directly via Claude through an MCP server.

## What it does

- **Capture** text thoughts; AI extracts type, topics, people, action items, priority, dates, memory type, and temporal anchors
- **Search** using hybrid semantic + full-text search (pgvector + tsvector) with memory-aware relevance decay
- **Compound** knowledge into auto-maintained topic pages — pre-synthesized summaries updated on every capture, prepended as context in search results
- **Schedule** tasks with due dates, priorities, and recurrence rules
- **Decompose** multi-topic inputs into atomic thoughts automatically, with parent context injected in search results
- **Classify** memories as fact, preference, episodic, or procedural — each decays differently in search ranking
- **Relate** thoughts automatically via a knowledge graph (updates, extends, derives, related); explicit provenance via `source_ids`
- **Connect** entities — people, projects, organizations, tools, and places are extracted into a graph (`entities`, `thought_entities`, co-occurrence `entity_edges`) with auto-compiled per-entity wiki pages prepended to search results
- **Lint** the knowledge base — detect contradictions, orphaned thoughts, stale facts, and near-duplicates
- **Profile** synthesize a structured user profile from captured knowledge (static facts + dynamic activity)
- **Version** every thought update; history archived in `thought_versions`
- **MCP server** exposes 17 tools so Claude can read, write, reason, and maintain the knowledge base directly
- **Skills** ship prompt-only packs that operate on the base (meeting synthesis, research synthesis, idea panning, entity briefs) — see [`skills/`](skills/)
- **Auto-capture** evaluate every Claude Code turn through a relevance gate and save worthy exchanges silently after each assistant turn
- **Mine** historical Claude Code transcripts into the knowledge base with cost-safe batching and resume support
- **Translate** non-English content to English before storage so embeddings are consistent and search works regardless of the original conversation language

## Architecture

### Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router) + TypeScript |
| Backend / DB | Supabase (PostgreSQL + pgvector) |
| Edge functions | Deno (Supabase Edge Functions) |
| AI SDK | Vercel AI SDK (`ai` + `@ai-sdk/gateway`) |
| Embeddings | Vercel AI Gateway → OpenAI `text-embedding-3-small` |
| Metadata extraction | Vercel AI Gateway → Claude Haiku 4.5 |
| Styling | Tailwind CSS 4 |
| State | Zustand |
| Linting / formatting | Biome |

### Single-table design

Everything lives in one `thoughts` table. No type-specific extension tables, no fan-out routing.

**Real columns** (for efficient sorting/indexing): `due_at`, `priority` (0–4), `category`, `parent_id`, `is_bundle`, `expires_at`, `event_at`

**JSONB `metadata`** (flexible, GIN-indexed): type, topics, people, action_items, dates_mentioned, source, status, resolved_at, location, cost, url, rating, last_completed, completion_count, memory_type

**JSONB `recurrence`**: interval_days, unit, days_of_week, day_of_month, end_at

**Why single table:** Extension tables solve fragmentation that doesn't exist here. JSONB + GIN + pgvector gives flexible querying without the complexity of classification routing, dedup, and bidirectional sync. When adding new data kinds: enrich the metadata extraction prompt, or add a real column only if it needs efficient sorting/indexing. Don't create new tables.

### Topic pages (compounding layer)

Inspired by Karpathy's "LLM Wiki" pattern. Rather than re-synthesizing knowledge on every query (pure RAG), Echo maintains a `topic_pages` table of LLM-compiled summary documents — one per active topic.

**How it works:**
- When a topic accumulates 3+ thoughts, a page is created with a full LLM compilation
- Each subsequent capture **incrementally updates** the relevant page — the LLM sees only the existing summary + the new thought, not all source thoughts
- When `search_thoughts` is called, relevant topic pages are fetched and **prepended as a compiled preamble** before individual results — so the LLM gets pre-synthesized context without re-reading raw thoughts

Pages are updated non-blocking after capture (fire-and-forget — capture never fails if page update fails). Use `refresh_topic_page` to force a full recompilation.

### Capture pipeline

**One pipeline, every entry point.** `supabase/functions/_shared/capture.ts` defines what capturing a thought means; the REST API (`/api/thoughts` — used by the dashboard, the Claude Code hooks, and the mine CLI) and the MCP `capture_thought` tool are thin adapters over it, so every capture source gets identical behavior: idempotency, decomposition, and the full compounding layer.

Each capture runs:

1. **Metadata extraction** (Claude Haiku) — extracts type, topics, people (resolved against known person entities), action items, dates, memory type, `expires_at`, `event_at`, priority, category, recurrence, tools, person definitions, and cost/url/rating when present
2. **Embedding** (text-embedding-3-small) — generates a 1536-dim vector from enriched text (content + topics + category + people appended) so semantic similarity captures metadata concepts, not just raw text. Runs after extraction because the enriched text depends on it.

**Language normalization:** Before reaching the capture pipeline, content sourced from Claude Code hooks or the mine CLI is translated to English by the relevance gate. All stored content and topics land in a single language space so embeddings are consistent and cross-language searches work correctly.

After saving, **relation detection** runs (awaited — searches for high-similarity existing thoughts and asks the LLM to classify the relationship: updates / extends / derives / related), then the rest of the compounding layer runs non-blocking: **topic page updates**, **entity graph projection + entity page refreshes**, and **person-definition upserts**. In Next.js the non-blocking work is scheduled via `after()` so it survives the response.

### Hybrid search

`hybrid_search` RPC blends **70% vector similarity** (pgvector cosine) + **30% full-text rank** (tsvector). A thought matches if either similarity exceeds threshold or a full-text match exists. A `search_vector` column is maintained by trigger on `content`, topics, and category. Expired thoughts (`expires_at < now()`) are filtered at the DB level.

### Search result enrichment

A `search_thoughts` response is composed of three layers, in order:

1. **Topic page preamble** — relevant topic pages (fetched via `search_topic_pages` RPC, same 70/30 blend) are prepended as compiled summaries. The LLM gets pre-synthesized context before seeing individual results.
2. **Individual results** — decay-adjusted similarity scores (memory type multiplier applied post-query), sorted descending. Bundle parents excluded.
3. **Parent context injection** — decomposed child thoughts include their parent bundle's original text as "Original context", so the full capture is visible without duplicating results.

The whole read path — embedding, `hybrid_search`, bundle exclusion, decay, parent context, page preambles, and the tuning knobs — is implemented once in `supabase/functions/_shared/search.ts`. The MCP tool and the REST `POST /api/search` endpoint (which returns `{ results, pages }`) are formatting adapters over it.

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

When a new thought is captured, it's compared against existing thoughts via `hybrid_search` (match threshold ≥ 0.65). Matches are classified by the LLM into relation types:

- **updates** — new thought contradicts/replaces old (marks previous as superseded via `is_latest = false`)
- **extends** — new thought adds detail without replacing
- **derives** — logical consequence of an existing thought
- **related** — topically connected but independent

Relations are stored in a `thought_relations` table and traversable via the `get_thought_context` tool.

**Explicit provenance:** `capture_thought` accepts `source_ids: string[]`. When provided, `derives` relations are created at confidence 1.0 without going through the LLM classifier — deterministic provenance for when Claude synthesizes an answer from specific sources and captures it.

### Entity graph & pages

While `thought_relations` links thoughts to thoughts, the entity graph links thoughts to the **things they're about**. Each capture projects its extracted metadata (people, project, organization, location, tools) into deduped nodes:

- **`entities`** — one row per `(type, canonical_name)`; `mention_count` maintained by trigger
- **`thought_entities`** — evidence links (which thought mentions which entity)
- **`entity_edges`** — undirected co-occurrence edges with a weight (entities mentioned together)

People are not a separate table — they're `entities` rows with `type = 'person'`, carrying their relationship role on `metadata.role`. `people.ts` is the curated-identity view over those rows (resolving "my mother-in-law" → canonical name during extraction); the graph projects the same person nodes from `metadata.people`, which is already resolved to canonical names. The projection runs fire-and-forget after capture; `backfill-entities.ts` populates the graph from existing thoughts (API-free).

**Entity pages** are the entity analogue of topic pages — one LLM-compiled wiki page per entity that crosses the 3-thought threshold, stored in `entity_pages`. Pages are *generated artifacts*: each refresh is a full recompile from the entity's linked thoughts plus its strongest co-occurrence edges, so the SQL tables remain the single source of truth and pages never drift. Relevant entity pages are prepended to `search_thoughts` results alongside topic pages. Tools: `list_entities`, `get_entity`, `refresh_entity_page`.

### Decomposition

When a capture is long or covers multiple topics, the LLM automatically splits it into atomic thoughts. The original becomes a parent bundle (`is_bundle = true`) and is excluded from search results. Child thoughts reference it via `parent_id`.

When a decomposed child appears in search results, the parent bundle's content is fetched and included as "Original context" — giving the LLM the full picture without sacrificing atomic precision.

### Lint

On-demand health-check across the entire corpus via the `lint_thoughts` tool. Four checks, run selectively or all at once:

- **Contradictions** (LLM) — fetches all `fact` and `preference` thoughts, groups them by topic overlap, and sends each cluster to Claude Haiku to identify conflicting claims (e.g. two different doctors, two different addresses)
- **Orphans** (SQL) — episodic thoughts older than 90 days with no relations and no parent bundle; candidates for deletion or consolidation
- **Stale facts** (SQL) — facts/preferences where all `updates` relations pointing to them have `is_latest = false`, meaning they've been fully superseded
- **Near-duplicates** (embedding) — thought pairs with cosine similarity ≥ 0.95 via the `find_near_duplicates` RPC; candidates for merging

### Profile synthesis

`get_profile` synthesizes a structured user profile from captured thoughts. It queries two independent sets:

- **Static** (limit 100) — `fact` and `preference` memory types; things that persist
- **Dynamic** (limit 50) — recent `episodic` thoughts + open tasks; current context

Both sets are sent to Claude Haiku, which returns structured JSON covering facts, preferences, known people, active projects, upcoming events, recent topics, and open tasks. An optional `focus` parameter emphasizes a specific domain.

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
| `capture_thought` | Save a new thought; extracts metadata, detects relations, updates topic pages, supports decomposition and explicit `source_ids` |
| `search_thoughts` | Hybrid search with decay-adjusted scores, topic page preamble, and parent context injection |
| `list_thoughts` | Filtered listing with sorting by date, due date, or priority |
| `list_due` | Show overdue and upcoming tasks |
| `update_thought` | Modify content/metadata; archives previous version |
| `resolve_thought` | Mark done (or reopen); for recurring: advances due date |
| `delete_thought` | Permanently delete with cascade to versions and relations |
| `thought_stats` | Summary statistics |
| `get_thought_context` | Traverse the knowledge graph — show a thought and all its relations (depth 1–2) |
| `get_profile` | Synthesize a structured user profile (static facts/preferences + dynamic activity) |
| `list_topic_pages` | List all compiled topic pages with titles, source counts, and last-updated dates |
| `get_topic_page` | Retrieve a topic page by slug or ID — full compiled summary + source thought IDs |
| `refresh_topic_page` | Force full recompilation of a topic page from all its source thoughts |
| `list_entities` | List graph entities (people, projects, organizations, tools, places) by mention count, filterable by type |
| `get_entity` | Retrieve an entity by id or name — its wiki page, mentioning thoughts, and co-occurring entities |
| `refresh_entity_page` | Force full recompilation of an entity's wiki page from its linked thoughts and edges |
| `lint_thoughts` | Health-check: detect contradictions, orphaned episodic thoughts, stale facts, and near-duplicates |

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

## Claude Code auto-capture

Two optional hooks turn Echo into a passive memory layer for every Claude Code session. Install once; they run silently after that.

### Stop hook — per-turn capture

Fires after every assistant turn. Reads the last user→assistant exchange from the session transcript, runs it through a Haiku **relevance gate**, and POSTs to Echo if worthy. Idempotent via `source_id = <session>:<turnIndex>` — re-running or restarting Claude Code never creates duplicates.

**Gate captures (any one is enough):**
- Decisions made or confirmed (architectural, library, business, lifestyle)
- Expressed preferences ("I prefer X", "always do Y", "avoid Z")
- Non-obvious learnings, gotchas, domain facts
- Action items or follow-ups
- New project context (goals, constraints, stakeholders)

**Gate skips:** tool output dumps, trivial back-and-forth, unresolved debugging, re-statements of public docs.

### PreCompact hook — compaction bookmark

Fires before context compression. Summarizes the last 12 exchanges into an episodic thought with a 30-day expiry. Ensures mid-flight context — open problems, current hypotheses, in-progress decisions — survives compaction.

### Language translation

Both hooks instruct Haiku to translate any non-English content to English before producing output. This keeps all stored content and topics in a single language space so embeddings are consistent and search works regardless of the original conversation language.

### Install

Add to `~/.claude/settings.json` (or `~/.claude/settings.local.json`). Update the `command` paths to match your local clone.

```jsonc
{
  "env": {
    "ECHO_API_URL": "http://localhost:3000"
  },
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /path/to/echo/scripts/claude-hooks/stop-hook.ts",
            "timeout": 30
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /path/to/echo/scripts/claude-hooks/pre-compact-hook.ts",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

**Required env** (set in your shell profile or in the `"env"` block above):

| Var | Description |
|---|---|
| `AI_GATEWAY_API_KEY` | Same key Echo uses for metadata extraction and embeddings |
| `ECHO_API_URL` | URL where the Echo server is running (default: `http://localhost:3000`) |

Both hooks fail silently — any error logs to stderr and exits 0 so they never block a session.

### Verify

After installing, have a short Claude Code conversation with one clear decision and one off-topic exchange, then:

```bash
curl 'http://localhost:3000/api/thoughts?days=1' | jq '.[] | select(.source_kind=="claude-transcript")'
```

Expect: the decision captured, the off-topic not. Trigger compaction and confirm a `claude-precompact` thought appears with `memory_type: "episodic"` and `expires_at` ~30 days out.

---

## Transcript mining

`scripts/mine-claude-transcripts.ts` backfills Echo from historical Claude Code session files in `~/.claude/projects/`. Safe to re-run at any time — fully idempotent via checkpoint + unique `source_id` index.

### How it works

1. **Pre-filter (no LLM)** — drops tool-output-only turns, short messages, and queue operations. Eliminates ~50–70% of turns before any API spend.
2. **Relevance gate (Haiku)** — surviving turns go through the same gate as the Stop hook. Non-English content is translated to English before evaluation.
3. **Capture** — gate-positive turns POST to `/api/thoughts` with `source_kind: "claude-transcript"`.
4. **Checkpoint** — progress saved to `~/.echo-mine-state.json` after every turn. `Ctrl+C`-safe; re-run continues from where it stopped.

### Usage

```bash
# Measure exposure across all projects — no API calls, free
bun run mine --dry-run

# Process one project (recommended: start with the smallest to validate gate quality)
bun run mine --project quantic --batch-size 250

# Tune gate prompt and redo a project from scratch cheaply
bun run mine --project quantic --reset-checkpoint

# Custom budget cap
bun run mine --project echo --batch-size 250 --max-cost-usd 2.00
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `--dry-run` | off | Measure and plan only. No API calls. Writes `scripts/mine-progress.md`. |
| `--project <name>` | required | One of: `echo`, `worthscene`, `ora`, `quantic` |
| `--batch-size <N>` | 250 | Max gate calls per run (~10% of total exposure) |
| `--max-cost-usd <N>` | 1.50 | USD ceiling per run; stops gracefully, checkpoint saved |
| `--reset-checkpoint` | off | Clear checkpoint for the project before running |

### Progress tracking

After each run, `scripts/mine-progress.md` (gitignored — per-machine state) is updated with a batch checklist, a run-log table, and a copy-paste command for the next batch. Open it to see exactly where you are and what to run next.

Projected cost: ~$1.00–1.50 per batch of 250 turns at Haiku 4.5 rates ($1/M input, $5/M output).

### Allowed projects

The allowlist is hardcoded in `scripts/mine-claude-transcripts.allowlist.ts`. Extending scope requires editing the source and committing — intentional. There is no `--allow-any` escape hatch.

---

## Project structure

```
echo/
├── app/
│   ├── api/
│   │   ├── thoughts/       # CRUD — thin adapter over the shared capture/resolve workflows
│   │   ├── search/         # Hybrid search endpoint
│   │   └── stats/          # Dashboard stats
│   ├── capture/page.tsx
│   ├── thoughts/[id]/page.tsx
│   └── page.tsx            # Dashboard
├── components/
├── lib/                    # Next.js-side adapters/bindings over _shared
│   ├── model.ts            # Node adapter at the model-call seam (Vercel AI SDK)
│   ├── ai.ts               # Bindings of the shared LLM functions to the Node adapter
│   ├── capture.ts          # Binding of the shared capture pipeline
│   ├── relevance-gate.ts   # Binding of the shared relevance gate (hooks + mine CLI)
│   ├── types.ts            # Re-export of _shared/types.ts
│   ├── supabase.ts
│   └── store.ts            # Zustand store
├── scripts/
│   ├── claude-hooks/
│   │   ├── stop-hook.ts        # Stop hook — feeds the last turn to the ingestion workflow
│   │   ├── pre-compact-hook.ts # PreCompact hook — compaction bookmark
│   │   ├── catch-up.ts         # Reprocess recent transcripts through the ingestion workflow
│   │   └── README.md           # Hook install instructions
│   ├── lib/
│   │   ├── ingest.ts                # Transcript ingestion: prefilter → gate → idempotent POST
│   │   ├── transcript-prefilter.ts  # JSONL transcript parser + cheap pre-filter
│   │   ├── cost-tracker.ts          # Token + USD tracking with per-batch ceiling
│   │   ├── mine-state.ts            # Checkpoint state (persisted to ~/.echo-mine-state.json)
│   │   └── progress-file.ts         # Writes scripts/mine-progress.md
│   ├── mine-claude-transcripts.ts           # Mine CLI entry point
│   ├── mine-claude-transcripts.allowlist.ts # Hardcoded project allowlist
│   ├── backfill-relations.ts                # Backfill thought_relations graph
│   └── backfill-entities.ts                 # Backfill the entity graph (API-free)
├── skills/                 # Prompt-only skill packs over the Echo MCP tools
│   ├── meeting-synthesis/
│   ├── research-synthesis/
│   ├── panning-for-gold/
│   └── entity-brief/
└── supabase/
    ├── functions/
    │   ├── _shared/            # Runtime-neutral domain modules (imported by Next.js AND Deno)
    │   │   ├── types.ts        # Domain types — single source of truth
    │   │   ├── model.ts        # The model-call seam (Ai interface)
    │   │   ├── deps.ts         # EchoDeps: { db, ai } injected into every workflow
    │   │   ├── ai.ts           # All LLM schemas, prompts, and functions
    │   │   ├── capture.ts      # The capture pipeline (decomposition + compounding side effects)
    │   │   ├── projection.ts   # Extracted metadata → { metadata, columns, embedding } (capture + update)
    │   │   ├── search.ts       # The search read path (decay, parent context, page preambles, knobs)
    │   │   ├── list-thoughts.ts    # The thought-listing filter interface (MCP tools + REST)
    │   │   ├── relation-graph.ts   # thought_relations → { nodes, edges } (graph route + context tool)
    │   │   ├── lint.ts             # The knowledge-base health checks (lint_thoughts tool)
    │   │   ├── relevance-gate.ts   # The auto-capture relevance gate (Stop hook + mine CLI)
    │   │   ├── page-lifecycle.ts   # Compiled-page invariants shared by topic and entity pages
    │   │   ├── resolve.ts      # Resolve-and-advance workflow
    │   │   ├── recurrence.ts   # Pure recurrence date math
    │   │   ├── search-assembly.ts  # Memory-decay scoring
    │   │   ├── people.ts / entities.ts / topic-pages.ts / entity-pages.ts
    │   │   └── *.test.ts       # Workflow tests against fake db/ai adapters
    │   └── echo-mcp/
    │       ├── index.ts        # Hono app + MCP server factory (v6.0.0)
    │       ├── config.ts       # Env validation + Deno Supabase client
    │       ├── model.ts        # Deno adapter at the model-call seam (raw fetch to AI Gateway)
    │       ├── ai.ts / people.ts / topic-pages.ts / entity-pages.ts  # Bindings to _shared
    │       └── tools/          # One thin adapter per MCP tool (17 tools)
    └── migrations/
        ├── 00002_add_versioning.sql
        ├── …
        ├── 00012_topic_pages.sql
        ├── 00013_lint_support.sql
        ├── 00015_add_source_tracking.sql
        ├── 00021_entities.sql
        └── 00022_entity_pages.sql
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
AI_GATEWAY_API_KEY=<vercel-ai-gateway-key>
```

Edge function secrets (set via Supabase dashboard or CLI):

```
MCP_PUBLISHABLE_KEY=<generate a random string — this is the bearer token for MCP>
MCP_ACCESS_KEY=<access key for reembed-thoughts function>
AI_GATEWAY_API_KEY=<vercel-ai-gateway-key>
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
# Apply migrations
supabase db push

# Deploy edge function
supabase functions deploy echo-mcp

# Set secrets
supabase secrets set MCP_PUBLISHABLE_KEY=<value>
supabase secrets set AI_GATEWAY_API_KEY=<value>
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
| Runtime-neutral `_shared` module layer | Capture, resolve, extraction, and page lifecycles are implemented once; Next.js and the edge function are thin adapters, so the two runtimes cannot drift |
| Model calls behind an `Ai` seam | Two adapters already existed (Vercel AI SDK in Node, raw fetch in Deno); prompts and schemas are now a single edit, and tests inject fakes |
| Extraction before embedding (sequential) | The embedding input is enriched with extracted metadata (topics, category, people) — consistent vectors beat the latency win of parallel calls |
| Enriched embeddings (content + topics/category appended) | Semantic search matches on metadata concepts, not just raw text |
| Bundles excluded from search | Parent bundles are containers; searching them would return duplicate/redundant results |
| Resolve-and-advance for recurrence | Simpler than a scheduler; recurring tasks self-propagate on completion |
| Memory-type decay applied post-query | Keeps the DB function simple; decay logic is easy to tune in application code |
| `event_at` as real column (not JSONB) | Enables efficient temporal range queries and sorting |
| Relation detection threshold ≥ 0.65 | Originally 0.8, but the hybrid score blends vector + full-text rank, so few pairs cleared it and graph edges rarely formed; 0.65 surfaces enough candidates, with the LLM classifier as the false-positive filter |
| `is_latest` flag on relations | Cleaner than `superseded_by` in metadata for tracking update chains |
| `topic_pages` as a separate table (not reusing `thoughts`) | Topic pages are system-generated compilations; mixing them into `thoughts` would require filtering them out of every existing query, list, stat, and decomposition check |
| Topic page updates are non-blocking (fire-and-forget) | Capture must never fail because a background compilation failed; data loss on page miss is acceptable |
| `source_ids` bypasses LLM relation classifier | Explicit provenance is always `derives` at confidence 1.0 — no need to re-classify what the caller already knows |
| Lint tool is on-demand, not a background job | Keeps the user in the loop; contradiction detection via LLM requires a deliberate trigger |
| Auto-capture uses a relevance gate (not capture-everything) | Firehose capture creates noise that degrades search quality; gate cost (~$0.001/turn) is negligible vs. the recall benefit |
| Translation folded into the gate call (not a separate step) | Adds zero extra API calls — Haiku receives the original exchange and produces English output in one shot |
| Single-language storage (always English) | Embeddings for the same concept in different languages land in different vector spaces; a single-language corpus is a hard requirement for consistent semantic search |
| `source_id` unique partial index (not application-level dedup) | Dedup at the DB layer is race-condition-safe and works across independent re-runs of the mine CLI without any coordination |
| Mine CLI is user-invoked, not auto-run | Bulk historical ingestion involves real cost decisions; the user should see the dry-run projection before any spend happens |
| Mine pre-filter runs before the gate | Dropping ~50–70% of turns via cheap regex before any LLM call keeps the per-batch cost predictable and avoids wasting gate calls on tool noise |

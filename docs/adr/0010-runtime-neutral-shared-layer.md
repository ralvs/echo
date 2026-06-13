# Domain logic lives in a runtime-neutral `_shared` layer; runtimes are adapters

Capture, resolve, extraction, search, listing, the page lifecycles, and every prompt are implemented once in `supabase/functions/_shared/`, which imports nothing runtime-specific — it depends only on the `EchoDeps` (`{ db, ai }`) handed in by its caller. The two runtimes are thin adapters: Next.js (`lib/`) constructs `EchoDeps` from the Node Supabase client and the Vercel AI SDK; the Deno edge function (`echo-mcp/`) constructs it from the Deno client and a raw-fetch model adapter. ADRs 0005–0008 are all instances of this rule.

## Why

Echo runs the same workflows from a Next.js server and a Deno edge function. Without a shared core, every capability would be implemented twice and the two copies would drift — the failure mode this layer exists to prevent. Dependency injection of `db` and `ai` keeps the core free of environment reads and makes it testable against fakes.

## Consequences

- `_shared` must stay portable across Node and Deno — no `process.env`, no Node-only or Deno-only imports. The model-call seam (`Ai`) and the db client are the only runtime concretions, and both arrive via `EchoDeps`.
- Deploying the edge function (`supabase functions deploy echo-mcp`) is the integration check that `_shared` still bundles under Deno; `deno check` catches type-level drift locally.
- New behaviour goes in `_shared` with a workflow test; the runtime entry point only formats input/output. Don't add domain logic to a route handler or an MCP tool.

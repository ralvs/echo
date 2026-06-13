# The `Ai` seam carries an optional `generateWithUsage`

The `Ai` interface (`_shared/model.ts`) exposes `generate` (text only) plus an **optional** `generateWithUsage` that also returns `{ inputTokens, outputTokens }`. Both production adapters (Vercel AI SDK, Deno raw fetch) implement it; the relevance gate calls it when present and falls back to zero usage when it isn't. This let the gate move into `_shared` (so the Stop hook, catch-up, and mine CLI share one prompt) without forcing every test fake and future adapter to fabricate token counts.

## Why this is recorded

A reader will see two near-identical methods and assume one is dead, or wonder why usage isn't simply always returned. The trade-off was deliberate:

- **Always-return-usage** would make every fake `Ai` in the test suite invent token numbers it doesn't care about.
- **A separate metering seam** would split "call the model" across two interfaces for the one caller (the gate) that meters cost.

Optional-with-fallback keeps the common path (`generate`) trivial to fake and confines usage reporting to the adapters and the one caller that needs it. Don't "tidy" this by deleting `generate` or making `generateWithUsage` required.

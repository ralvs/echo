# Lint moved into `_shared` on testability, not a second adapter

`_shared/lint.ts` owns the four knowledge-base health checks — `findContradictions` (LLM), `findOrphans` (SQL), `findStaleFacts` (SQL), `findDuplicates` (embedding RPC) — and a `lintThoughts` orchestrator returning a typed `LintReport`. The `lint_thoughts` MCP tool is a formatting adapter: it selects checks and renders sections. There is currently **one** caller.

## Why this is recorded

This looks like it violates ADR-0001 ("two adapters make a real seam; one makes a hypothetical one"). It doesn't — it's where ADR-0001 and ADR-0010 meet, and ADR-0010 wins for a specific reason. ADR-0001 governs the *db store*: don't wrap a query in a named operation until a second workflow needs it, because the only thing gained is relocation. The lint checks aren't a relocated query — they're ~140 lines of domain logic (the orphan relation-exclusion set, the stale-fact "every update superseded" predicate, the contradiction topic-clustering) that lived inside an MCP tool and could only be exercised by booting the server against a live database. ADR-0010's rule is explicit: domain logic goes in `_shared` *with a workflow test*, and the runtime entry point only formats.

So the justifying gain here is **the interface as the test surface**, not a second runtime. The set logic and the predicate now have unit tests against a fake db; the tool shrank to section rendering.

## Consequences

- The two-adapter test from ADR-0001 is not the universal gate. When a runtime entry point accumulates substantial, branching domain logic that can't be tested in place, it belongs in `_shared` even with a single caller — testability is sufficient justification on its own.
- `findContradictions` takes `EchoDeps` (it needs the `ai` seam for `detectContradictions`); the three SQL/RPC checks take only `db`. Don't widen them to a uniform signature for symmetry's sake.
- A future REST or dashboard lint view becomes a second formatting adapter with zero change to the checks — but that possibility is a bonus, not the reason this moved.

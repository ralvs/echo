# Limit the db seam to the thoughts write-path — no full repositories

We narrowed the `EchoDeps.db` seam by introducing `_shared/thoughts-store.ts` with named operations (`getCurrentThought`, `archiveThoughtVersion`, `writeThought`, `NON_BUNDLE_FILTER`) and stopped there. We deliberately did **not** wrap `entities`, `people`, `thought_relations`, or the lint queries in repositories, even though raw Supabase query chains still live in those modules.

## Why

Two adapters make a real seam; one makes a hypothetical one. The thoughts write-path had two real callers crossing it (`update.ts` and `resolve.ts`, both needing identical version-archival and patch semantics), so a named store earns its keep there. The entity/people/lint queries each have a single caller and no second adapter, so wrapping them would add interface without leverage — a shallow module that just relocates the query.

## Consequences

- Raw `.from(...).select(...)` chains remain in `entities.ts`, `people.ts`, `entity-pages.ts`, and the lint tool. This is intentional, not unfinished work.
- The store grows by the same rule: an operation moves into it when a **second** workflow needs it, or when a test fake would otherwise have to mimic its query chain.
- A future architecture review will likely re-suggest a full repository layer. This ADR is the standing answer: revisit only when a concrete second caller appears.

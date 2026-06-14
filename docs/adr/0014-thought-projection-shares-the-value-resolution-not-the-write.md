# The thought projection shares the value resolution, not the write shape

`_shared/projection.ts` (`projectThought`) owns what capture and update do *identically*: turn extracted metadata plus caller overrides into the JSONB `metadata` object, the resolved real-column values, and the enriched embedding text — one override-precedence rule, one status rule, one enrichment. Capture maps the result to an `insert`; update maps it to a `patch`. What stays in the adapters is the write *shape*, which genuinely differs.

## Why this is recorded

The duplication this removed was already drifting: `saveSingleThought` and `updateThought` each carried the same destructure-and-rebuild block, kept in sync by a `// same rule as capture` comment, and had silently diverged (`||` vs `??` for the effective due date, an unguarded vs guarded status set, a category that defaulted to null on one path but not the other). The projection makes the value each field takes a single source of truth.

A future reader will see capture build a full row while update builds a sparse patch and propose folding the column application into the shared module too. That is the rejected option:

- **Insert** defaults an absent column to `null` (capture writes `row.category = columns.category` unconditionally).
- **Patch** must leave an absent column *untouched* (update only sets `patch.category` when the resolved value is non-null), because writing `null` would erase an existing value the edit never mentioned.

`projectThought` therefore resolves each column to a value-or-`null` and lets each caller decide what `null` means. The status rule is unified on the *guarded* form (`metadata.status === undefined && actionable`); capture has no carried status, so the guard is always satisfied there — behaviour-preserving, not a change.

## Consequences

- `ProjectionOptions.carry` (preserve `status`/`resolved_at`/`last_completed`/`completion_count`) and `metadataPatch` are update-only inputs; capture passes neither. Don't "simplify" them away.
- The metadata-only update path (no content change) does **not** call `projectThought` — there's nothing extracted to project — and applies its column overrides directly. This split is intentional.

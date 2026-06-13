# Compaction bookmarks bypass the relevance gate

The PreCompact hook captures its summary through `ingestRaw()`, which skips the Haiku relevance gate that every transcript turn passes through in `ingestTurn()`. A bookmark is a deliberate, already-summarized snapshot of in-flight context — it has by definition decided it's worth keeping, so gating it would only risk discarding the one capture the user most wants to survive compaction.

## Why this is recorded

The obvious assumption is that *all* captures gate (the Stop hook, catch-up, and the mine CLI all do). Skipping the gate looks like an oversight. It isn't: the seam exposes two entries on purpose — `ingestTurn` (gated) and `ingestRaw` (ungated) — so the choice is made *at* the seam, not by reaching around it. Don't "fix" the bookmark path to run through the gate.

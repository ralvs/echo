---
name: panning-for-gold
description: >
  Sift a long brain dump, voice-note transcript, or freewrite into a ranked
  inventory of ideas, then capture only the keepers into Echo. Use when the user
  pastes a stream-of-consciousness dump and wants the signal pulled out without
  saving the noise. Invoked via /panning-for-gold.
---

# Panning for Gold

Most of a brain dump is silt. Find the nuggets, discard the rest.

## Step 1 — Inventory

Read the dump and extract every distinct idea, task, fact, or question as a
one-line item. Do not merge distinct items; do not editorialize yet.

## Step 2 — Rank

Score each item:

- **Keep** — durable value: a decision, a fact, a real task, a genuine idea.
- **Maybe** — interesting but vague or speculative; needs a trigger to matter.
- **Drop** — venting, duplication, or transient noise.

For "Keep" items, dedupe against what already exists: `search_thoughts` on each
before capturing, so you extend rather than duplicate. If a near-duplicate
exists, prefer updating context over a fresh capture.

## Step 3 — Present

Show the ranked inventory (Keep / Maybe / Drop) and let the user veto before
anything is saved.

## Step 4 — Capture keepers

For each approved item, `capture_thought` as an atomic, self-contained
statement — set `type`, and `due_at`/`priority` for tasks. Let Echo handle
metadata extraction and memory classification.

Report a one-line tally: kept N, skipped M, dropped K.

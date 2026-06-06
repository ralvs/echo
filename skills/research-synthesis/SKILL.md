---
name: research-synthesis
description: >
  Answer a question from everything Echo already knows, producing findings,
  contradictions, and an explicit confidence assessment rather than a flat
  summary. Use when the user asks "what do I know about X", "synthesize my
  notes on Y", or wants a grounded position backed by their own knowledge base.
  Invoked via /research-synthesis.
---

# Research Synthesis

Turn scattered captures into a grounded, honestly-hedged synthesis.

## Step 1 — Cast a wide net

For the user's question:

- `search_thoughts` with several phrasings of the question (synonyms, narrower
  and broader terms). Aim for recall — run 3–5 searches.
- If the question centers on a person, project, organization, tool, or place,
  `get_entity` to fetch its compiled wiki page and related entities.
- `get_topic_page` for any directly relevant topic to get pre-synthesized context.

Track the source thought IDs behind each claim.

## Step 2 — Synthesize

Produce four sections:

- **Findings** — what the evidence supports, each with a brief inline citation
  to the source thought(s).
- **Contradictions** — places where captures disagree. Show both values and,
  if datable, which is more recent.
- **Gaps** — what the question needs that Echo has no capture for.
- **Confidence** — High / Medium / Low, with one sentence on why (volume,
  recency, and consistency of evidence).

Do not pad with outside knowledge. If the base is thin, say so plainly — a
low-confidence answer grounded in real captures beats a confident guess.

## Step 3 — Offer to capture

If the synthesis itself is worth keeping, offer to `capture_thought` it with
`source_ids` set to the thoughts it draws from, so the conclusion is linked back
to its evidence.

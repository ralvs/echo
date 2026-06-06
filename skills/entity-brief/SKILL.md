---
name: entity-brief
description: >
  Assemble a briefing on a person, project, organization, tool, or place using
  Echo's entity graph — its compiled wiki page, the thoughts mentioning it, and
  the entities it co-occurs with. Use before a meeting or call ("brief me on
  Sarah", "what's the state of project Echo", "remind me about Anthropic").
  Invoked via /entity-brief.
---

# Entity Brief

A focused, graph-backed dossier on one entity.

## Step 1 — Resolve the entity

- `get_entity` by name (pass `type` if ambiguous, e.g. a project and a person
  share a name). This returns the compiled wiki page, recent thoughts, and the
  related entities it most often co-occurs with.
- If the name doesn't resolve, `list_entities` (optionally filtered by type) to
  find the closest match, then retry.

## Step 2 — Deepen if stale or thin

- If `get_entity` shows no wiki page (entity below the page threshold) or the
  page looks out of date, run `search_thoughts` on the entity name to pull raw
  captures directly.
- If the page is stale after recent captures, `refresh_entity_page` to recompile
  it before briefing.

## Step 3 — Brief

Produce a tight briefing:

- **Who/what it is** — one line, from the wiki page.
- **Latest** — the most recent 2–3 developments, newest first.
- **Open threads** — unresolved tasks or questions tied to this entity.
- **Connections** — the related entities that matter and why (from the graph
  edges), e.g. "frequently appears alongside project X and Anthropic".

Keep it skimmable. End with anything the user should do or decide.

## Step 4 — Capture new context (optional)

If the briefing surfaces a new fact the user confirms, `capture_thought` it so
the next brief is sharper.

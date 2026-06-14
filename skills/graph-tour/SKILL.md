---
name: graph-tour
description: >
  Take a guided tour of the shape of your knowledge graph using Echo's
  graph-intelligence tools — the central concepts, the clusters/themes, and the
  surprising connections that bridge them — then reflect on what they reveal and
  what's worth exploring next. Use when the user asks "what have I been thinking
  about", "show me the shape of my notes", "what connects across my work", or
  wants a periodic step-back over their whole corpus. Invoked via /graph-tour.
---

# Graph Tour

The reflective layer over Echo's structural graph analysis. The tools give the
facts; this skill narrates them and turns them into questions worth sitting with
— the personal-knowledge analog of a codebase's GRAPH_REPORT.

## Step 1 — Read the structure

- `graph_overview` to get the whole picture in one call: the most central
  concepts ("god nodes"), the clusters and their members, and the strongest
  cross-cluster bridges. Start with the default `min_weight`; if the clusters
  look noisy (lots of incidental one-off pairings), re-run with `min_weight: 2`
  to focus on the salient structure.

## Step 2 — Probe the interesting bits

- For any **surprising connection** that stands out, `find_path` between the two
  entities to see the chain that links them, then `get_entity` on the bridging
  node to read why they co-occur.
- For a **cluster** you want to understand, `get_entity` on its most central
  member (or `get_topic_page` if a matching topic page exists) to ground the
  theme in actual thoughts.

## Step 3 — Narrate the tour

Walk the user through what the graph shows, newest insight first. Keep it
skimmable:

- **What's central** — the 2–3 concepts everything orbits, and what that says
  about where attention has gone.
- **The themes** — name each meaningful cluster in plain language (not just its
  label) and what ties its members together.
- **Surprising connections** — for each bridge, why it's interesting: a person
  spanning two separate areas, a tool showing up in unrelated projects. These
  are the non-obvious links graphify-style reports exist to surface.

## Step 4 — Reflect

Close with **questions worth exploring**, drawn from the structure, not
invented:

- An isolated-but-central node nobody connects to → "is this under-developed?"
- Two clusters joined by a single weak bridge → "should these be more
  connected, or are they genuinely separate?"
- A god node with thin thoughts behind it → "worth capturing more here?"

Offer 3–5 concrete prompts. If the user engages with one, `capture_thought` any
new insight so the next tour is richer.

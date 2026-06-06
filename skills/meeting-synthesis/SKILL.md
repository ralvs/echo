---
name: meeting-synthesis
description: >
  Turn raw meeting notes or a transcript into structured decisions, action
  items, and follow-ups, then capture each into Echo as its own thought. Use
  when the user pastes meeting notes, a call transcript, or says "synthesize
  this meeting" / "what did we decide". Invoked via /meeting-synthesis.
---

# Meeting Synthesis

Convert messy meeting notes into durable, searchable knowledge in Echo.

## Step 1 — Gather context

The user supplies notes or a transcript. Before synthesizing, pull related
context so decisions connect to existing knowledge:

- `search_thoughts` with the meeting's main topics and any project names.
- If a named project, person, or organization recurs, `get_entity` on it to see
  prior decisions and open threads.

## Step 2 — Extract structure

Read the notes and produce four sections. Be faithful — never invent items.

- **Decisions** — what was settled, with the chosen option and (if stated) why.
- **Action items** — concrete to-dos. Capture owner and due date when present.
- **Open questions** — unresolved threads to revisit.
- **Context** — durable facts worth keeping (numbers, names, constraints).

Show this summary to the user before capturing.

## Step 3 — Capture into Echo

Capture each item as its own atomic thought via `capture_thought`:

- Action items → `type: "task"`, set `due_at` and `priority` when known.
- Decisions and durable facts → `type: "observation"` (let Echo classify
  memory_type), with `topics` including the project name.
- Pass `source_ids` if these derive from an existing thought, so provenance is
  recorded.

Prefer many small captures over one blob — Echo's decomposition works best on
atomic, self-contained statements.

## Step 4 — Confirm

Report what was captured (counts by type) and surface any action item missing an
owner or due date so the user can fill the gap.

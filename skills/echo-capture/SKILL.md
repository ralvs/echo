---
name: echo-capture
description: >
  Capture insights from the current conversation into Echo. In Claude Code agent
  sessions, runs the catch-up script to process the full transcript. In Desktop
  chat (no terminal), reviews the conversation and calls Echo MCP tools directly.
  Use at the end of any session to ensure nothing worth keeping was missed.
  Invoked via /echo-capture.
---

# Echo Capture

Review the current conversation and save any insights worth keeping to Echo.

## Step 1 — Determine context

- **Claude Code agent session** (you have Bash tool access): run the catch-up script.
- **Desktop chat / no terminal** (you only have MCP tools): review and call `capture_thought` directly.

## Step 2a — Agent session (Bash available)

Run the catch-up script on transcripts from the last 2 hours:

```bash
cd /Volumes/stuff/renan/echo && bun run scripts/claude-hooks/catch-up.ts --hours 2
```

This calls the shared capture pipeline directly against Supabase with a
service-role client — no HTTP hop, no dev server required. See
[`scripts/claude-hooks/README.md`](../../scripts/claude-hooks/README.md) for
how the pipeline and the Stop/PreCompact hooks it backstops work.

Report how many turns were captured, skipped, and whether any errors occurred.

## Step 2b — Desktop chat (no Bash, Echo MCP available)

Go back through this conversation. For each exchange, decide:

**Capture** if it contains any of:
- A decision the user made or confirmed (technical, architectural, lifestyle, business)
- An expressed preference ("I prefer X", "always do Y", "avoid Z")
- A non-obvious learning, gotcha, or fact about a system or domain
- An action item or follow-up the user should remember
- New project context (goals, constraints, stakeholders)

**Skip** if it's:
- Trivial Q&A, pleasantries, or confirmations
- Tool output or code execution results
- Re-statements of public documentation
- Unresolved debugging with no conclusion

For each insight worth capturing, call `capture_thought` with a concise, self-contained statement written in the user's voice — one that will make sense six months from now without this conversation for context.

After reviewing the full conversation, summarize: how many thoughts were captured and what they were about.

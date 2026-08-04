---
name: dream
description: >
  Review and act on proposed memory changes from Echo's dream workflow — the
  nightly scan of recent transcripts and knowledge-base health checks that
  surfaces corrections, new facts, stale entries, and near-duplicates as a
  numbered list. Use when the user says "/dream", asks to review or run
  dream proposals, or wants to apply/reject specific numbered proposals.
  Invoked via /dream.
---

# Dream

Review and act on Echo's proposed memory changes, never applying anything the
user didn't explicitly ask for.

## Step 1 — Determine context

- **Terminal available** (Claude Code / Grok CLI, you have Bash tool access):
  run the CLI directly.
- **No terminal** (Claude Desktop / Grok web, only MCP tools): call
  `dream_review` / `dream_apply` and say plainly if the nightly hasn't run.

## Commands

| Command | With a terminal | Without a terminal |
|---|---|---|
| `/dream` | `cd /Volumes/stuff/renan/echo && bun run dream --hours 24`, present the numbered list | `dream_review({})` |
| `/dream review` | same as above (or re-run with the same window to show last night's queue) | `dream_review({})` — shows the pending queue from last night |
| `/dream apply 1,3` | n/a — CLI is dry-run only in this phase | `dream_apply({ apply: [1, 3] })` |
| `/dream apply all` | n/a | `dream_apply({ apply: "all" })` |
| `/dream reject 2 <reason>` | n/a | `dream_apply({ reject: [2], note: "<reason>" })` — also suppresses that fingerprint for 30 days |

## Step 2a — Terminal session

Run:

```bash
cd /Volumes/stuff/renan/echo && bun run dream --hours 24
```

Present the numbered proposals exactly as printed, including confidence,
targets, and evidence quotes. This CLI path is dry-run only — it does not
apply or reject anything. To act on a proposal, the user needs a client with
MCP access (Claude Desktop, Grok, or an MCP-enabled session).

## Step 2b — MCP session (Desktop / Grok web)

- `dream_review({})` shows the latest report. If it says no report was found,
  or the report's health section flags the capture pipeline as stale, say so
  plainly rather than guessing — the nightly run may not have executed yet.
- `dream_review({ report: "<source_id>" })` for a specific past report.

## Step 3 — Applying or rejecting

**Never call `dream_apply` with numbers the user did not type; when the
report is ambiguous, show it again rather than guessing.**

- `dream_apply({ apply: [1, 3] })` for specific numbers the user named.
- `dream_apply({ apply: "all" })` only when the user explicitly says "apply
  all" or equivalent — never as a default.
- `dream_apply({ reject: [2], note: "<reason>" })` to reject, with an
  optional reason. A rejected proposal's fingerprint is suppressed from
  future dream runs for 30 days.

`merge` and `expire` proposals mutate or hide existing memories (a merge
rewrites content and retires the source thoughts; an expire hides a fact from
future retrieval) — give those a closer look before applying than plain
`create` proposals, which only add.

## Step 4 — Report back

After any apply/reject call, show the per-proposal outcome exactly as
returned, including failures — never report a failed apply as a success.

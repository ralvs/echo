# Echo Claude Code hooks

Two hooks turn Echo into a passive memory layer for Claude Code:

- **`stop-hook.ts`** — runs after every assistant turn. Reads the last user→assistant exchange, asks a Haiku relevance gate whether it's worth saving, and captures it via the shared capture pipeline (a direct, service-role call — no HTTP hop) if yes. Idempotent via `source_id = <session>:<turnIndex>`.
- **`pre-compact-hook.ts`** — runs before context compression. Summarizes the last ~12 exchanges into a bookmark thought (`memory_type: "episodic"`, 30-day expiry) so mid-flight context survives compaction.

Both hooks **fail silently** — any error logs to stderr and exits 0 so they never block your session.

## Why hooks must `cd` to the echo project root

Both hooks call the Vercel AI Gateway (`AI_GATEWAY_API_KEY`) and the shared capture pipeline directly against Supabase with a service-role client (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). Those keys live in `.env.local` in this repo. Bun loads `.env.local` from the **current working directory** — which is the CWD of the Claude Code session, not the script directory. Sessions in any other project would run without the keys and fail silently.

The fix: prefix every hook command with `cd /path/to/echo &&` so Bun always loads the right `.env.local`.

## Scope: what these hooks cover

| Session type | Hooks fire? | Notes |
|---|---|---|
| Claude Code CLI (any project) | ✅ Yes | Stop + PreCompact both work |
| Claude Desktop — agent mode | ✅ Yes | Same Claude Code binary, same JSONL transcripts |
| Claude Desktop — regular chat | ❌ No | No local transcript; no hook possible |

For regular Desktop chat, use `/echo-capture` at the end of a conversation: Claude will review the full conversation and call `capture_thought` via the Echo MCP for anything worth keeping.

## Catch-up script

`catch-up.ts` is a safety net that processes all transcripts modified in the last N hours:

```bash
# From the echo project root:
bun run scripts/claude-hooks/catch-up.ts --hours 48
bun run scripts/claude-hooks/catch-up.ts --file ~/.claude/projects/.../session.jsonl
```

Echo deduplicates by `source_id`, so re-running is always safe.

## Install

Add to `~/.claude/settings.json` (or `~/.claude/settings.local.json`). Note the `cd` prefix — it is required.

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cd /Volumes/stuff/renan/echo && bun run scripts/claude-hooks/stop-hook.ts",
            "timeout": 60
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cd /Volumes/stuff/renan/echo && bun run scripts/claude-hooks/pre-compact-hook.ts",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

## Required env

`AI_GATEWAY_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` are loaded automatically from `.env.local` in the echo project root when hooks use the `cd /path/to/echo &&` prefix. No shell profile changes needed.

These timeouts (`60`s Stop, `120`s PreCompact) cover the whole in-process pipeline now — save, relation detection, plus the compounding work (topic pages, entity linking, person backfill) that used to run after the response under Next's `after()` and now runs inline before the hook exits.

## What the gate captures (and skips)

The gate's prompt lives in [`lib/relevance-gate.ts`](../../lib/relevance-gate.ts). It captures:

- Decisions you made or confirmed.
- Stated preferences ("I prefer X", "always do Y").
- Non-obvious learnings, gotchas, or domain facts.
- Action items / follow-ups.
- New project context (goals, constraints, stakeholders).

It skips trivia, tool-output noise, short clarifying questions, and unresolved debugging.

If signal-to-noise is bad after the first batches, edit the prompt in `lib/relevance-gate.ts` and use `--reset-checkpoint --project <name>` on the mine CLI to redo the affected project cheaply.

## Disabling temporarily

The `command` paths in `settings.json` are the on/off switch. Comment out or remove the entries to stop captures. Existing captures stay; nothing is destructive.

## Verifying

After installing, have a short Claude Code conversation that includes one clear decision and one off-topic ramble, then:

```bash
bun run scripts/claude-hooks/catch-up.ts --hours 24
```

Expect: the decision captured, the ramble not. Trigger a compaction (long session) and confirm a `claude-precompact` thought appears with `memory_type: "episodic"`.

No dev server is needed — ingestion calls the capture pipeline directly on a
service-role key. `/api/thoughts` is gated behind `requireOwner()` and answers
only to a browser session, so it is not a verification path.

Hooks always exit 0 so a capture failure never blocks a session. That means
**stderr is not where failures show up** — check `~/Library/Logs/echo/ingest.err.log`,
which gets one JSON line per failure. Set `ECHO_LOG_DIR` to relocate it.

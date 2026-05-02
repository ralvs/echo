# Echo Claude Code hooks

Two hooks turn Echo into a passive memory layer for Claude Code:

- **`stop-hook.ts`** — runs after every assistant turn. Reads the last user→assistant exchange, asks a Haiku relevance gate whether it's worth saving, and POSTs to Echo if yes. Idempotent via `source_id = <session>:<turnIndex>`.
- **`pre-compact-hook.ts`** — runs before context compression. Summarizes the last ~12 exchanges into a bookmark thought (`memory_type: "episodic"`, 30-day expiry) so mid-flight context survives compaction.

Both hooks **fail silently** — any error logs to stderr and exits 0 so they never block your session.

## Install

Add to `~/.claude/settings.json` (or `~/.claude/settings.local.json`). The `command` paths must be absolute.

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /Volumes/stuff/renan/echo/scripts/claude-hooks/stop-hook.ts",
            "timeout": 30
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
            "command": "bun run /Volumes/stuff/renan/echo/scripts/claude-hooks/pre-compact-hook.ts",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

## Required env

The hooks call the Vercel AI Gateway (Haiku) and the local Echo API. Set these in your shell profile (or pass through Claude Code's hook env):

```bash
# AI Gateway key — same one Echo's existing extractor uses.
export AI_GATEWAY_API_KEY=...

# Where the Next.js dev/prod server is running.
export ECHO_API_URL=http://localhost:3000
```

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
# Inside this repo, with the dev server running:
curl 'http://localhost:3000/api/thoughts?days=1' | jq '.[] | select(.source_kind=="claude-transcript")'
```

Expect: the decision captured, the ramble not. Trigger a compaction (long session) and confirm a `claude-precompact` thought appears with `memory_type: "episodic"`.

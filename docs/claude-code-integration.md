# Claude Code Integration

This guide covers everything needed to set up Echo as a passive memory layer for Claude Code sessions from scratch.

## What gets set up

| Component | Purpose |
|-----------|---------|
| **Stop hook** | After every assistant turn, evaluates the exchange and saves durable insights to Echo |
| **PreCompact hook** | Before context compression, saves a 30-day bookmark summarizing the in-flight session |
| **echo-capture skill** | Manual `/echo-capture` command for reviewing a conversation and capturing what the hooks may have missed |
| **Echo MCP server** | Gives Claude direct access to Echo tools (`capture_thought`, `search_thoughts`, etc.) in Desktop chat |

---

## 1. Hooks

The hooks live in `scripts/claude-hooks/` in this repo. They require Bun and an active Echo server (local or deployed).

### How to install

Add to `~/.claude/settings.json` (global) or `~/.claude/settings.local.json`. The `cd` prefix is **required** — it ensures Bun loads `.env.local` from this repo regardless of which project directory Claude is running in.

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cd /path/to/echo && bun run scripts/claude-hooks/stop-hook.ts",
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
            "command": "cd /path/to/echo && bun run scripts/claude-hooks/pre-compact-hook.ts",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/echo` with the absolute path to this repo on your machine.

### What the stop hook captures (and skips)

The gate prompt lives in [`lib/relevance-gate.ts`](../lib/relevance-gate.ts). It uses Claude Haiku to evaluate each exchange.

**Captures:**
- Decisions made or confirmed (architectural, library, business, lifestyle)
- Expressed preferences ("I prefer X", "always do Y", "avoid Z")
- Non-obvious learnings, gotchas, or facts about a system or domain
- Action items or follow-ups that need to be remembered
- New project context (goals, constraints, stakeholders)

**Skips:**
- Pure code execution results, file reads, tool output dumps
- Trivial back-and-forth ("ok", "thanks", "yes please")
- Re-statements of public documentation
- Short clarifying questions without resolution
- Long debugging sessions with no conclusion

### Hook coverage

| Session type | Hooks fire? |
|---|---|
| Claude Code CLI (any project) | ✅ Yes |
| Claude Desktop — agent mode | ✅ Yes |
| Claude Desktop — regular chat | ❌ No — use `/echo-capture` instead |
| Cursor | ❌ Skipped (detected via `cursor_version` field) |

### Catch-up script

If hooks were not installed for a period, `catch-up.ts` backfills from existing transcripts. Echo deduplicates by `source_id` so re-running is always safe.

```bash
# From the echo project root:
bun run scripts/claude-hooks/catch-up.ts --hours 48
bun run scripts/claude-hooks/catch-up.ts --file ~/.claude/projects/.../session.jsonl
```

---

## 2. echo-capture skill

The `/echo-capture` skill is for Desktop chat sessions where hooks cannot fire. At the end of any conversation, run `/echo-capture` and Claude will review the full exchange, calling `capture_thought` via the Echo MCP for anything worth keeping.

### How to install

1. Create the skills directory if it doesn't exist:

```bash
mkdir -p ~/.claude/skills/echo-capture
```

2. Copy the skill file:

```bash
cp scripts/claude-hooks/echo-capture-skill/SKILL.md ~/.claude/skills/echo-capture/SKILL.md
```

Or create `~/.claude/skills/echo-capture/SKILL.md` with the following content:

```markdown
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

\`\`\`bash
cd /path/to/echo && bun run scripts/claude-hooks/catch-up.ts --hours 2
\`\`\`

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
```

Replace `/path/to/echo` in Step 2a with the absolute path to this repo.

---

## 3. Echo MCP server

The Echo MCP server exposes Echo tools to Claude directly, enabling `capture_thought`, `search_thoughts`, `list_thoughts`, and others in Claude Code, Claude Desktop, Claude web, and Claude iOS/Android.

The server is a Supabase Edge Function deployed at the project's Supabase URL (Streamable HTTP). It supports two auth modes — pick based on which Claude surface you're configuring.

### Claude Desktop / web / iOS / Android — custom connector (OAuth)

Desktop, web, and the mobile apps only support OAuth-based custom connectors — there's no UI to paste a static bearer token. Echo's edge function doubles as an OAuth-protected resource server backed by Supabase Auth's OAuth 2.1 server.

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. URL: `https://<your-supabase-project>.supabase.co/functions/v1/echo-mcp`.
3. A browser window opens at Echo's login + consent page. Sign in with the single owner account and click **Allow**.
4. Once added on claude.ai, the connector is also available on Claude iOS/Android automatically. Requires a paid Claude plan (Pro/Max/Team/Enterprise).

Behind the scenes: the edge function returns `401` + a `WWW-Authenticate` header pointing Claude at `/.well-known/oauth-protected-resource`; Claude discovers Supabase's OAuth server from there, self-registers via dynamic client registration, and runs a normal OAuth+PKCE flow. The resulting access token is validated against Supabase Auth and checked against the `ECHO_OWNER_USER_ID` allowlist on every request — only the project owner's account can ever reach the tools, regardless of how many OAuth clients register themselves.

### Claude Code CLI — `mcp-remote` (legacy static token)

Claude Code can attach a custom header, so it keeps using a static bearer token via `mcp-remote`. This path still works and is unaffected by the OAuth setup above.

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "echo": {
      "command": "mcp-remote",
      "args": [
        "https://<your-supabase-project>.supabase.co/functions/v1/echo-mcp",
        "--header",
        "Authorization:Bearer <your-mcp-token>"
      ]
    }
  }
}
```

- **`mcp-remote`** must be installed: `npm install -g mcp-remote`
- **MCP token** is the `MCP_PUBLISHABLE_KEY` secret set on the `echo-mcp` edge function.
- **TODO(oauth-only):** this is a transitional path. Once Claude Code supports OAuth for HTTP MCP servers end-to-end in your workflow (hooks/scripts included), migrate this to OAuth too and remove the static-key branch from `echo-mcp/index.ts`.

### Available tools

| Tool | Description |
|------|-------------|
| `capture_thought` | Save a new thought |
| `search_thoughts` | Semantic + keyword search |
| `list_thoughts` | List recent or filtered thoughts |
| `get_thought_context` | Fetch context around a thought |
| `update_thought` | Edit an existing thought |
| `delete_thought` | Remove a thought |
| `resolve_thought` | Mark a thought as resolved |
| `lint_thoughts` | Find duplicates and stale entries |
| `get_profile` | Retrieve the user profile |
| `get_topic_page` | Get a compiled topic summary |
| `list_topic_pages` | List all topic pages |
| `refresh_topic_page` | Recompile a topic page |
| `list_due` | List thoughts with upcoming due dates |
| `thought_stats` | Aggregate counts and metrics |

---

## Verifying the setup

After installing the hooks, have a short Claude Code conversation that includes one clear decision and one off-topic exchange:

```bash
# Check that the stop hook captured the decision:
curl 'http://localhost:3000/api/thoughts?days=1' | jq '.[] | select(.source_kind=="claude-transcript")'

# Check that a compaction bookmark was saved (trigger a long session or manual compact):
curl 'http://localhost:3000/api/thoughts?days=1' | jq '.[] | select(.source_kind=="claude-precompact")'
```

Expect: the decision captured, the off-topic exchange not.

---

## Disabling temporarily

Remove or comment out the `hooks` entries in `settings.json`. Existing captures are unaffected — nothing is destructive.

# Echo Skills

Version-controlled agent skills that operate *on* the Echo knowledge base. Each
skill is a prompt-only behavior — it orchestrates Echo's MCP tools
(`search_thoughts`, `capture_thought`, `get_entity`, `get_profile`, …) rather
than adding code or schema.

| Skill | What it does |
|---|---|
| [`meeting-synthesis`](meeting-synthesis/SKILL.md) | Turn raw notes or a transcript into decisions, action items, and follow-ups, then capture each into Echo. |
| [`research-synthesis`](research-synthesis/SKILL.md) | Pull everything Echo knows on a question and produce findings, contradictions, and a confidence assessment. |
| [`panning-for-gold`](panning-for-gold/SKILL.md) | Sift a brain dump into a ranked idea inventory and capture only the keepers. |
| [`entity-brief`](entity-brief/SKILL.md) | Assemble a briefing on a person, project, organization, tool, or place from the entity graph. |
| [`graph-tour`](graph-tour/SKILL.md) | Tour the shape of the whole graph — central concepts, clusters, and surprising connections — then reflect on what's worth exploring. |
| [`dream`](dream/SKILL.md) | Review and act on the nightly dream workflow's proposed memory changes — apply, reject, or run it on demand. |
| [`echo-capture`](echo-capture/SKILL.md) | Capture insights from the current conversation into Echo, via the catch-up script (terminal) or `capture_thought` (Desktop chat). |

## Installing

Skills are discovered from `~/.claude/skills/` (Claude Code / Claude Desktop)
and `~/.grok/skills/` (Grok CLI reads `SKILL.md` the same way) — symlink every
pack into both. Run [`scripts/install-skills.sh`](../scripts/install-skills.sh)
to do this idempotently for everything under `skills/`, or symlink individual
packs by hand:

```bash
for target in "$HOME/.claude/skills" "$HOME/.grok/skills"; do
  for s in meeting-synthesis research-synthesis panning-for-gold entity-brief graph-tour dream echo-capture; do
    ln -s "$(pwd)/skills/$s" "$target/$s"
  done
done
```

They require the Echo MCP server to be configured (see
[docs/claude-code-integration.md](../docs/claude-code-integration.md)).

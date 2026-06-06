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

## Installing

Skills are discovered from `~/.claude/skills/`. Symlink the packs you want:

```bash
for s in meeting-synthesis research-synthesis panning-for-gold entity-brief; do
  ln -s "$(pwd)/skills/$s" "$HOME/.claude/skills/$s"
done
```

They require the Echo MCP server to be configured (see
[docs/claude-code-integration.md](../docs/claude-code-integration.md)).

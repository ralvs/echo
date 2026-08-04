#!/usr/bin/env bash
#
# Symlinks every skill directory under skills/ into both ~/.claude/skills/
# and ~/.grok/skills/ (Grok CLI reads SKILL.md the same way Claude Code
# does). Idempotent: a target that already points at the right place is
# left alone, and this script never deletes anything that isn't a symlink
# into this repo — a real directory at the target (e.g. a stale unversioned
# copy) is reported and skipped rather than clobbered.
#
# Usage: ./scripts/install-skills.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="$REPO_ROOT/skills"
TARGETS=("$HOME/.claude/skills" "$HOME/.grok/skills")

if [[ ! -d "$SKILLS_DIR" ]]; then
	echo "No skills directory at $SKILLS_DIR" >&2
	exit 1
fi

installed=0
skipped=0
conflicts=0

for target_dir in "${TARGETS[@]}"; do
	mkdir -p "$target_dir"
	echo "== $target_dir =="

	for skill_path in "$SKILLS_DIR"/*/; do
		[[ -d "$skill_path" ]] || continue
		skill_name="$(basename "$skill_path")"
		skill_src="$SKILLS_DIR/$skill_name"
		link_path="$target_dir/$skill_name"

		if [[ -L "$link_path" ]]; then
			current_target="$(readlink "$link_path")"
			# Resolve relative symlink targets against the target dir before comparing.
			if [[ "$current_target" != /* ]]; then
				current_target="$(cd "$target_dir" && cd "$(dirname "$current_target")" 2>/dev/null && pwd)/$(basename "$current_target")"
			fi
			if [[ "$current_target" == "$skill_src" ]]; then
				echo "  skip   $skill_name (already linked)"
				skipped=$((skipped + 1))
				continue
			fi
			echo "  relink $skill_name (was -> $current_target)"
			rm "$link_path"
			ln -s "$skill_src" "$link_path"
			installed=$((installed + 1))
		elif [[ -e "$link_path" ]]; then
			# A real file or directory, not a symlink into this repo — never
			# delete it automatically. The caller has to resolve this by hand
			# (e.g. move the stale copy aside).
			echo "  CONFLICT $skill_name exists at $link_path and is not a symlink into this repo — skipped, resolve manually"
			conflicts=$((conflicts + 1))
		else
			ln -s "$skill_src" "$link_path"
			echo "  link   $skill_name"
			installed=$((installed + 1))
		fi
	done
done

echo ""
echo "Installed/updated: $installed, already correct: $skipped, conflicts needing manual resolution: $conflicts"
if [[ "$conflicts" -gt 0 ]]; then
	exit 1
fi

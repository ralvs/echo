/**
 * Owner-authorship gate for transcript turns.
 *
 * WHY THIS EXISTS: the `user` role in a Claude Code / Grok transcript is not
 * the Owner. The CLI harness injects its own content under that role —
 * system reminders, the global CLAUDE.md echoed back, MCP/skill listings,
 * slash-command bodies, git status, tool results — and the Owner's actual
 * typed text is appended after it, if there is any at all.
 *
 * A 2026-08-04 dream run made this concrete: 7 of 12 proposals were mined
 * from Grok turns whose "user message" was 16,740 characters of pure
 * harness preamble with zero Owner-authored residue. The pipeline treated a
 * subagent's architecture report as a durable fact about the Owner.
 *
 * `ownerText` strips the machine-authored wrappers and returns only what the
 * Owner actually wrote. Empty residue means the turn had no Owner voice in
 * it and must never reach the capture or dream classifiers.
 *
 * This fails toward silence: an unrecognized wrapper leaks through as
 * residue (a false keep), but nothing the Owner typed is ever discarded.
 */

/**
 * Harness-injected blocks, stripped wholesale. Only these exact tags are
 * removed — arbitrary `<tag>` stripping would eat Owner text that happens to
 * quote XML or HTML, which is common in this corpus.
 */
const MACHINE_TAGS = [
	"system-reminder",
	"user_info",
	"git_status",
	"command-message",
	"command-name",
	"command-args",
	"local-command-stdout",
	"local-command-stderr",
	"ide_selection",
	"ide_opened_file",
	"image_files",
	"env",
] as const;

/**
 * Wrappers the harness puts *around* the Owner's own words rather than
 * instead of them. The tag is removed and the contents kept — Grok CLI wraps
 * every typed prompt in <user_query>, so stripping these wholesale would
 * discard the entire Owner corpus for that source.
 */
const UNWRAP_TAGS = ["user_query"] as const;

/**
 * Residues that are themselves machine-authored even though they sit outside
 * any wrapper tag. Matched against the *start* of the stripped residue, since
 * each of these is a whole-message form rather than an inline fragment.
 */
const MACHINE_RESIDUE_PREFIXES = [
	// A slash-command expansion: the skill's SKILL.md body is delivered as a
	// user message right after the <command-name> block.
	"base directory for this skill:",
	// Tool results and hook output replayed under the user role.
	"tool_use_id",
	"caller_is_claude",
	"posttooluse:",
	"pretooluse:",
	"result of calling the",
	// Subagent completion notifications.
	"task notification:",
	"agent task completed",
] as const;

/**
 * Substrings that mark a residue as harness output wherever they appear.
 * Kept deliberately short — each one is a literal the harness emits and that
 * the Owner has no reason to type.
 */
const MACHINE_RESIDUE_MARKERS = [
	"the following skills are available",
	"the following deferred tools are now available",
	"available agent types for the agent tool",
	"# global claude.md",
] as const;

function stripTag(text: string, tag: string): string {
	// Paired form first, then any unterminated opener (a transcript truncated
	// mid-block would otherwise leak the whole tail through as residue).
	const paired = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi");
	const dangling = new RegExp(`<${tag}>[\\s\\S]*$`, "i");
	return text.replace(paired, "\n").replace(dangling, "\n");
}

/** Removes every known harness-injected block, leaving the rest untouched. */
export function stripMachineBlocks(text: string): string {
	let out = text;
	for (const tag of MACHINE_TAGS) out = stripTag(out, tag);
	for (const tag of UNWRAP_TAGS) {
		out = out.replace(new RegExp(`</?${tag}>`, "gi"), "");
	}
	return out.trim();
}

/**
 * What the Owner actually typed in this message, or "" when the message is
 * entirely machine-authored.
 */
export function ownerText(raw: string): string {
	const residue = stripMachineBlocks(raw ?? "");
	if (!residue) return "";

	const lowered = residue.toLowerCase();
	if (MACHINE_RESIDUE_PREFIXES.some((p) => lowered.startsWith(p))) return "";
	if (MACHINE_RESIDUE_MARKERS.some((m) => lowered.includes(m))) return "";

	return residue;
}

/** Whether a message carries any Owner-authored text at all. */
export function isOwnerAuthored(raw: string): boolean {
	return ownerText(raw).length > 0;
}

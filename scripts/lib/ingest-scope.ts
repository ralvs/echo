import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The only directories whose sessions may be ingested into Echo.
 *
 * This replaces the former per-project allowlist. The allowlist required
 * editing a committed file for every new personal project; this rule covers
 * new personal projects automatically while still excluding everything else
 * by default. The paper trail it provided is preserved: these roots are a
 * committed constant with no runtime escape hatch.
 *
 * WHY THIS EXISTS: this machine also runs Cursor for employer work, whose
 * repositories live at /Volumes/stuff/lss, /Volumes/stuff/members and
 * /Volumes/stuff/engines.code-workspace — siblings of renan/, not children.
 * Claude Code can run inside Cursor (a VS Code fork) and would write those
 * sessions into the same ~/.claude/projects/ tree. This prefix is the only
 * thing keeping employer work out of a personal knowledge base.
 *
 * If personal projects ever move out of /Volumes/stuff/renan/, or an employer
 * repository is ever placed inside it, this guard silently inverts. Revisit
 * this constant before relocating either.
 */
export const INGEST_ROOTS = ["/Volumes/stuff/renan/"] as const;

/** Normalize a root so prefix comparison is unambiguous. */
function normalizeRoot(root: string): string {
	return root.endsWith("/") ? root : `${root}/`;
}

/**
 * Whether a session working directory may be ingested.
 *
 * Fails closed: an empty, relative, or unresolvable path returns false. The
 * path is resolved through realpath first so a symlink cannot smuggle an
 * excluded directory past the prefix check; when the path no longer exists
 * on disk (a deleted worktree, an unmounted volume) the lexical path is used
 * instead, which is still safe because the comparison is a prefix match.
 */
export function isIngestable(cwd: string | null | undefined): boolean {
	if (!cwd || typeof cwd !== "string") return false;
	const trimmed = cwd.trim();
	if (!trimmed.startsWith("/")) return false;

	let candidate: string;
	try {
		candidate = realpathSync(trimmed);
	} catch {
		candidate = resolve(trimmed);
	}

	const withSlash = candidate.endsWith("/") ? candidate : `${candidate}/`;
	return INGEST_ROOTS.some((root) => withSlash.startsWith(normalizeRoot(root)));
}

/**
 * The cwd a Grok CLI session directory encodes.
 *
 * Grok stores sessions at ~/.grok/sessions/<url-encoded-cwd>/<uuid>/, e.g.
 * "%2FVolumes%2Fstuff%2Frenan%2Fdispatch" for /Volumes/stuff/renan/dispatch.
 * Returns null when the segment is not decodable, so callers fail closed.
 */
export function decodeGrokCwd(encodedDirName: string): string | null {
	try {
		const decoded = decodeURIComponent(encodedDirName);
		return decoded.startsWith("/") ? decoded : null;
	} catch {
		return null;
	}
}

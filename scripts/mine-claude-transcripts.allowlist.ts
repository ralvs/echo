/**
 * Hardcoded allowlist for the mine-claude-transcripts CLI.
 *
 * The CLI refuses to process any project not in this list. Extending scope
 * requires editing this file and committing — no runtime escape hatch — so
 * there's a paper trail for every change to ingestion scope.
 *
 * Each entry is the directory name under ~/.claude/projects/ (which Claude
 * Code derives from the cwd by replacing slashes with dashes).
 */
export const ALLOWED_PROJECT_DIRS = [
	"-Volumes-stuff-renan-echo",
	"-Volumes-stuff-renan-worthscene",
	"-Volumes-stuff-ora",
	"-Volumes-stuff-renan-quantic",
] as const;

export type AllowedProjectDir = (typeof ALLOWED_PROJECT_DIRS)[number];

/**
 * Map a short project name (used in --project flag) to its directory.
 * Lets you type `--project echo` instead of the full path-derived name.
 */
export const PROJECT_ALIASES: Record<string, AllowedProjectDir> = {
	echo: "-Volumes-stuff-renan-echo",
	worthscene: "-Volumes-stuff-renan-worthscene",
	ora: "-Volumes-stuff-ora",
	quantic: "-Volumes-stuff-renan-quantic",
};

export function resolveProjectDir(name: string): AllowedProjectDir | null {
	const alias = PROJECT_ALIASES[name as keyof typeof PROJECT_ALIASES];
	if (alias) return alias;
	if ((ALLOWED_PROJECT_DIRS as readonly string[]).includes(name)) {
		return name as AllowedProjectDir;
	}
	return null;
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	type Contradiction,
	type DuplicateResult,
	type LintCheck,
	lintThoughts,
	type ThoughtRef,
} from "../../_shared/lint.ts";
import { supabase } from "../config.ts";
import { ai } from "../model.ts";
import { preview, registerTextTool } from "./contract.ts";

function dateLine(t: ThoughtRef, max: number): string {
	return `  • [${new Date(t.created_at).toLocaleDateString()}] ${preview(t.content, max)}\n    ID: ${t.id}`;
}

function contradictionsSection(items: Contradiction[]): string {
	if (!items.length) return "## Contradictions\nNone found.";
	const lines = items.map(
		(c) => `  • ${c.explanation}\n    → A: ${c.thought_a}\n    → B: ${c.thought_b}`,
	);
	return `## Contradictions (${items.length})\n${lines.join("\n\n")}`;
}

function orphansSection(items: ThoughtRef[]): string {
	if (!items.length) return "## Orphaned Episodic Thoughts\nNone found.";
	return `## Orphaned Episodic Thoughts (${items.length}, >90 days, no relations)\n${items
		.map((t) => dateLine(t, 80))
		.join("\n\n")}\nSuggested action: delete or consolidate.`;
}

function staleSection(items: ThoughtRef[]): string {
	if (!items.length) return "## Stale Facts\nNone found.";
	return `## Stale Facts (${items.length}, superseded by newer updates)\n${items
		.map((t) => dateLine(t, 80))
		.join("\n\n")}\nSuggested action: delete or archive.`;
}

function duplicatesSection(result: DuplicateResult): string {
	if (result.error) return `## Near-Duplicates\nError running check: ${result.error}`;
	if (!result.pairs.length) return "## Near-Duplicates\nNone found.";
	const lines = result.pairs.map(
		(d) =>
			`  • ${(d.similarity * 100).toFixed(1)}% similar\n    A [${d.thought_a}]: ${preview(d.content_a, 70)}\n    B [${d.thought_b}]: ${preview(d.content_b, 70)}`,
	);
	return `## Near-Duplicates (${result.pairs.length}, ≥95% similarity)\n${lines.join("\n\n")}\nSuggested action: delete one or merge.`;
}

export function registerLintThoughts(server: McpServer) {
	registerTextTool(
		server,
		"lint_thoughts",
		{
			title: "Lint Thoughts",
			description:
				"Health-check the knowledge base. Runs up to four checks: contradictions (conflicting facts), orphans (old isolated episodic thoughts), stale (superseded facts with no latest version), and duplicates (near-identical thoughts). Returns a structured report with IDs and suggested actions.",
			inputSchema: {
				checks: z
					.array(z.enum(["contradictions", "orphans", "stale", "duplicates"]))
					.optional()
					.default(["contradictions", "orphans", "stale", "duplicates"])
					.describe("Which checks to run. Default: all"),
				max_items: z.number().optional().default(10).describe("Max issues to report per category"),
			},
		},
		async ({ checks, max_items }) => {
			const report = await lintThoughts(
				{ db: supabase, ai, ownerName: ECHO_OWNER_NAME },
				{ checks: checks as LintCheck[], maxItems: max_items },
			);

			const sections: string[] = [];
			if (report.contradictions) sections.push(contradictionsSection(report.contradictions));
			if (report.orphans) sections.push(orphansSection(report.orphans));
			if (report.stale) sections.push(staleSection(report.stale));
			if (report.duplicates) sections.push(duplicatesSection(report.duplicates));

			return `# Echo Knowledge Base Lint Report\nChecks: ${checks.join(", ")}\n\n${sections.join("\n\n")}`;
		},
	);
}

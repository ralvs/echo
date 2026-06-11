import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { detectContradictions } from "../ai.ts";
import { supabase } from "../config.ts";

export function registerLintThoughts(server: McpServer) {
	server.registerTool(
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
			const sections: string[] = [];

			try {
				// --- Check 1: Contradictions (LLM-based) ---
				if (checks.includes("contradictions")) {
					const { data: facts } = await supabase
						.from("thoughts")
						.select("id, content, metadata")
						.in("metadata->>memory_type", ["fact", "preference"])
						.or("is_bundle.is.null,is_bundle.eq.false")
						.limit(200);

					const factList = (facts ?? []).map(
						(f: { id: string; content: string; metadata: Record<string, unknown> }) => ({
							id: f.id,
							content: f.content,
							topics: Array.isArray(f.metadata?.topics) ? (f.metadata.topics as string[]) : [],
						}),
					);

					const contradictions = await detectContradictions(factList);
					const limited = contradictions.slice(0, max_items);

					if (limited.length) {
						const lines = limited.map(
							(c) => `  • ${c.explanation}\n    → A: ${c.thought_a}\n    → B: ${c.thought_b}`,
						);
						sections.push(`## Contradictions (${limited.length})\n${lines.join("\n\n")}`);
					} else {
						sections.push("## Contradictions\nNone found.");
					}
				}

				// --- Check 2: Orphaned episodic thoughts (SQL) ---
				if (checks.includes("orphans")) {
					const cutoff = new Date();
					cutoff.setDate(cutoff.getDate() - 90);

					const { data: orphans } = await supabase
						.from("thoughts")
						.select("id, content, created_at")
						.eq("metadata->>memory_type", "episodic")
						.lt("created_at", cutoff.toISOString())
						.is("parent_id", null)
						.or("is_bundle.is.null,is_bundle.eq.false")
						.limit(max_items);

					// Filter out those with any relations
					const orphanIds = (orphans ?? []).map((t: { id: string }) => t.id);
					let trulyOrphaned: typeof orphans = orphans ?? [];

					if (orphanIds.length) {
						const { data: relatedIds } = await supabase
							.from("thought_relations")
							.select("source_id, target_id")
							.or(
								`source_id.in.(${orphanIds.map((id) => `"${id}"`).join(",")}),target_id.in.(${orphanIds.map((id) => `"${id}"`).join(",")})`,
							);

						const connectedIds = new Set(
							(relatedIds ?? []).flatMap((r: { source_id: string; target_id: string }) => [
								r.source_id,
								r.target_id,
							]),
						);
						trulyOrphaned = (orphans ?? []).filter((t: { id: string }) => !connectedIds.has(t.id));
					}

					if (trulyOrphaned.length) {
						const lines = trulyOrphaned.map(
							(t: { id: string; content: string; created_at: string }) => {
								const preview = t.content.length > 80 ? t.content.slice(0, 80) + "…" : t.content;
								return `  • [${new Date(t.created_at).toLocaleDateString()}] ${preview}\n    ID: ${t.id}`;
							},
						);
						sections.push(
							`## Orphaned Episodic Thoughts (${trulyOrphaned.length}, >90 days, no relations)\n${lines.join("\n\n")}\nSuggested action: delete or consolidate.`,
						);
					} else {
						sections.push("## Orphaned Episodic Thoughts\nNone found.");
					}
				}

				// --- Check 3: Stale facts (SQL) ---
				if (checks.includes("stale")) {
					// Facts/preferences that have an "updates" relation pointing TO them
					// where is_latest = false on all such relations (meaning they've been superseded)
					const { data: staleRows } = await supabase
						.from("thoughts")
						.select(
							`id, content, created_at, metadata,
							thought_relations!thought_relations_target_id_fkey(relation_type, is_latest)`,
						)
						.in("metadata->>memory_type", ["fact", "preference"])
						.or("is_bundle.is.null,is_bundle.eq.false")
						.limit(200);

					const stale = (staleRows ?? [])
						.filter((t: { thought_relations: { relation_type: string; is_latest: boolean }[] }) => {
							const updateRels = t.thought_relations.filter((r) => r.relation_type === "updates");
							return updateRels.length > 0 && updateRels.every((r) => r.is_latest === false);
						})
						.slice(0, max_items);

					if (stale.length) {
						const lines = stale.map((t: { id: string; content: string; created_at: string }) => {
							const preview = t.content.length > 80 ? t.content.slice(0, 80) + "…" : t.content;
							return `  • [${new Date(t.created_at).toLocaleDateString()}] ${preview}\n    ID: ${t.id}`;
						});
						sections.push(
							`## Stale Facts (${stale.length}, superseded by newer updates)\n${lines.join("\n\n")}\nSuggested action: delete or archive.`,
						);
					} else {
						sections.push("## Stale Facts\nNone found.");
					}
				}

				// --- Check 4: Near-duplicates (embedding) ---
				if (checks.includes("duplicates")) {
					const { data: dupes, error: dupesError } = await supabase.rpc("find_near_duplicates", {
						similarity_threshold: 0.95,
						max_results: max_items,
					});

					if (dupesError) {
						sections.push(`## Near-Duplicates\nError running check: ${dupesError.message}`);
					} else if (dupes?.length) {
						const lines = dupes.map(
							(d: {
								thought_a: string;
								thought_b: string;
								content_a: string;
								content_b: string;
								similarity: number;
							}) => {
								const previewA =
									d.content_a.length > 70 ? d.content_a.slice(0, 70) + "…" : d.content_a;
								const previewB =
									d.content_b.length > 70 ? d.content_b.slice(0, 70) + "…" : d.content_b;
								return `  • ${(d.similarity * 100).toFixed(1)}% similar\n    A [${d.thought_a}]: ${previewA}\n    B [${d.thought_b}]: ${previewB}`;
							},
						);
						sections.push(
							`## Near-Duplicates (${dupes.length}, ≥95% similarity)\n${lines.join("\n\n")}\nSuggested action: delete one or merge.`,
						);
					} else {
						sections.push("## Near-Duplicates\nNone found.");
					}
				}

				const checksRun = checks.join(", ");
				const report = `# Echo Knowledge Base Lint Report\nChecks: ${checksRun}\n\n${sections.join("\n\n")}`;

				return {
					content: [{ type: "text" as const, text: report }],
				};
			} catch (err: unknown) {
				return {
					content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}

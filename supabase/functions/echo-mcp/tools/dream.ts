import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	type ApplyOutcome,
	applyProposals,
	type DreamProposal,
	type DreamReport,
	getDreamReport,
	rejectProposals,
} from "../../_shared/dream.ts";
import { ECHO_OWNER_NAME, supabase } from "../config.ts";
import { ai } from "../model.ts";
import { preview, registerTextTool, ToolError } from "./contract.ts";

const deps = { db: supabase, ai, ownerName: ECHO_OWNER_NAME };

/**
 * Resolves the `report` input both tools share: "latest"/undefined means
 * the most recent dream report, anything else is treated as that report's
 * source_id (e.g. "dream:2026-08-04"). Dream reports are `is_bundle` rows,
 * invisible to search_thoughts/list_thoughts by design — dream_review and
 * dream_apply are the only MCP read path to them.
 */
async function resolveReport(reportArg?: string): Promise<DreamReport> {
	const sourceId = reportArg && reportArg !== "latest" ? reportArg : undefined;
	const report = await getDreamReport(supabase, { sourceId });
	if (!report) {
		throw new ToolError(
			sourceId
				? `No dream report found for "${sourceId}".`
				: "No dream report found yet. The nightly dream run may not have produced one — try `bun run dream --hours 24` from a terminal, or wait for the next scheduled run.",
		);
	}
	return report;
}

function proposalLine(p: DreamProposal): string {
	// Lint-derived proposals (duplicates/stale/contradictions) have no real
	// session/turn — session_id is the sentinel "lint". Printing "(session
	// lint, turn -1)" would be nonsense provenance, so suppress that suffix.
	const provenance =
		p.evidence.session_id === "lint"
			? ""
			: ` (session ${p.evidence.session_id}, turn ${p.evidence.turn_index}, ${p.evidence.at})`;
	const status =
		p.status !== "pending"
			? ` [${p.status}${p.resolution_note ? `: ${p.resolution_note}` : ""}]`
			: "";
	const lines = [
		`${p.n}. [${p.category}/${p.action}] confidence ${(p.confidence * 100).toFixed(0)}%${status}`,
		`   ${preview(p.proposed_content, 300) || "(none)"}`,
		`   targets: ${p.target_ids.length ? p.target_ids.join(", ") : "(none — new memory)"}`,
		`   evidence: "${preview(p.evidence.quote, 200)}"${provenance}`,
	];
	return lines.join("\n");
}

function outcomesSection(title: string, outcomes: ApplyOutcome[]): string {
	if (!outcomes.length) return "";
	const lines = outcomes.map((o) => {
		const marker =
			o.status === "applied"
				? "✓"
				: o.status === "rejected"
					? "✗"
					: o.status === "skipped"
						? "–"
						: "⚠";
		const detail = o.thoughtId ? ` → thought ${o.thoughtId}` : o.error ? ` — ${o.error}` : "";
		return `  ${marker} #${o.n} ${o.status}${detail}`;
	});
	return `## ${title}\n${lines.join("\n")}`;
}

export function registerDreamReview(server: McpServer) {
	registerTextTool(
		server,
		"dream_review",
		{
			title: "Dream Review",
			description:
				"Show the pending queue of proposed memory changes from a dream report — the nightly (or on-demand) scan of recent transcripts and knowledge-base health checks. Each proposal is numbered for use with dream_apply. Dream reports are bundle rows invisible to search_thoughts/list_thoughts; this is the only way to read them via MCP.",
			inputSchema: {
				report: z
					.string()
					.optional()
					.describe(
						'Which report to show: "latest" (default) or a specific report\'s source_id, e.g. "dream:2026-08-04".',
					),
			},
		},
		async ({ report: reportArg }) => {
			const report = await resolveReport(reportArg);
			const meta = report.metadata.dream;

			const sections: string[] = [];
			if (meta.health.capture_pipeline_stale) {
				sections.push(
					`⚠️ CAPTURE PIPELINE STALE — newest capture: ${meta.health.newest_capture_at ?? "never"}. Nightly ingestion may not be running; proposals below may be missing recent context.`,
				);
			}
			sections.push(
				`Run at: ${meta.run_at}\nWindow: ${meta.window.from} → ${meta.window.to}\nScanned: ${meta.scanned.turns} turns across ${meta.scanned.sessions} sessions | Cost: $${meta.cost_usd.toFixed(4)}`,
			);
			if (meta.auto_applied.length) {
				sections.push(`Auto-applied: ${meta.auto_applied.join(", ")}`);
			}

			if (!meta.proposals.length) {
				sections.push("No proposals.");
			} else {
				sections.push(
					`${meta.proposals.length} proposal(s):\n\n${meta.proposals.map(proposalLine).join("\n\n")}`,
				);
			}

			return `# Dream Report — ${report.source_id ?? report.id}\n\n${sections.join("\n\n")}`;
		},
	);
}

export function registerDreamApply(server: McpServer) {
	registerTextTool(
		server,
		"dream_apply",
		{
			title: "Dream Apply",
			description:
				'Apply and/or reject specific numbered proposals from a dream report (see dream_review). Requires explicit proposal numbers — pass apply/reject arrays, or apply: "all" to deliberately apply every pending proposal. There is no default that applies everything.',
			inputSchema: {
				report: z
					.string()
					.optional()
					.describe('Which report to act on: "latest" (default) or a specific source_id.'),
				apply: z
					.union([z.array(z.number()), z.literal("all")])
					.optional()
					.describe('Proposal numbers to apply, or "all" to apply every pending proposal.'),
				reject: z.array(z.number()).optional().describe("Proposal numbers to reject."),
				note: z
					.string()
					.optional()
					.describe("Optional reason recorded against rejected proposals."),
			},
		},
		async ({ report: reportArg, apply, reject, note }) => {
			if (apply === undefined && reject === undefined) {
				throw new ToolError(
					'dream_apply requires explicit proposal numbers: pass apply: [1, 3], apply: "all", and/or reject: [2]. There is no default that applies everything pending.',
				);
			}

			const report = await resolveReport(reportArg);
			const sections: string[] = [];

			if (apply !== undefined) {
				const outcomes = await applyProposals(deps, report.id, apply);
				sections.push(outcomesSection("Applied", outcomes));
			}
			if (reject?.length) {
				const outcomes = await rejectProposals(deps, report.id, reject, note);
				sections.push(outcomesSection("Rejected", outcomes));
			}

			return `# Dream Apply — ${report.source_id ?? report.id}\n\n${sections.filter(Boolean).join("\n\n")}`;
		},
	);
}

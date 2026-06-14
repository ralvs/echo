import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { egoGraph, type GraphNode } from "../../_shared/relation-graph.ts";
import { supabase } from "../config.ts";
import { preview, registerTextTool, ToolError } from "./contract.ts";

export function registerGetThoughtContext(server: McpServer) {
	registerTextTool(
		server,
		"get_thought_context",
		{
			title: "Get Thought Context",
			description:
				"Retrieve a thought and all its related thoughts (knowledge graph neighbors). Shows how thoughts connect via updates, extends, derives, or related relations.",
			inputSchema: {
				thought_id: z.string().describe("UUID of the thought to get context for"),
				depth: z
					.number()
					.optional()
					.default(1)
					.describe("How many hops to traverse (1 or 2, default 1)"),
			},
		},
		async ({ thought_id, depth }) => {
			const graph = await egoGraph(supabase, thought_id, { depth });
			if (!graph) throw new ToolError(`Thought not found: ${thought_id}`);

			const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
			const center = nodes.get(thought_id) as GraphNode;

			const header = (n: GraphNode) => {
				const m = n.metadata || {};
				return `  Type: ${m.type || "unknown"} | Created: ${new Date(n.created_at).toLocaleDateString()}${n.event_at ? ` | Event: ${new Date(n.event_at).toLocaleDateString()}` : ""}${n.category ? ` | Category: ${n.category}` : ""}`;
			};

			// Direct relations touch the centre; extended relations sit between its
			// neighbours (only present at depth 2).
			const direct = graph.edges.filter(
				(e) => e.source_id === thought_id || e.target_id === thought_id,
			);
			const extended = graph.edges.filter(
				(e) => e.source_id !== thought_id && e.target_id !== thought_id,
			);

			if (direct.length === 0) {
				return `[Thought] ${center.content}\n${header(center)}\n\n  No relations found.`;
			}

			const parts = [
				`[Thought] ${center.content}`,
				header(center),
				"",
				`Relations (${direct.length}):`,
			];

			for (const e of direct) {
				const isSource = e.source_id === thought_id;
				const otherId = isSource ? e.target_id : e.source_id;
				const direction = isSource ? "→" : "←";
				const other = nodes.get(otherId);
				const latestTag = e.is_latest === false ? " (superseded)" : "";
				const text = other ? preview(other.content, 120) : "(deleted)";
				parts.push(
					`  ${direction} ${e.relation_type} (${(e.confidence * 100).toFixed(0)}%${latestTag}): ${text}`,
					`    ID: ${otherId}`,
				);
			}

			if (extended.length > 0) {
				parts.push("", `Extended relations (depth 2, ${extended.length}):`);
				for (const e of extended) {
					const source = nodes.get(e.source_id);
					const target = nodes.get(e.target_id);
					const srcPreview = source ? source.content.substring(0, 60) : e.source_id.substring(0, 8);
					const tgtPreview = target ? target.content.substring(0, 60) : e.target_id.substring(0, 8);
					parts.push(`  ${srcPreview}... → ${e.relation_type} → ${tgtPreview}...`);
				}
			}

			return parts.join("\n");
		},
	);
}

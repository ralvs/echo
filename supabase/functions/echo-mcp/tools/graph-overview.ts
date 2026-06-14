import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type EntityNode, entityGraph, toWeightedGraph } from "../../_shared/entity-graph.ts";
import { communities, crossCommunityEdges, weightedDegree } from "../../_shared/graph-analysis.ts";
import { supabase } from "../config.ts";
import { registerTextTool } from "./contract.ts";

const MAX_GOD_NODES = 10;
const MAX_CLUSTER_MEMBERS = 10;
const MAX_BRIDGES = 8;

export function registerGraphOverview(server: McpServer) {
	registerTextTool(
		server,
		"graph_overview",
		{
			title: "Graph Overview",
			description:
				"A structural read of the whole knowledge graph: the most central concepts ('god nodes'), the clusters/themes entities fall into, and the surprising connections that bridge otherwise-separate clusters. Computed on demand from the co-occurrence graph. Use it to step back and see the shape of what you've been thinking about.",
			inputSchema: {
				min_weight: z
					.number()
					.optional()
					.default(1)
					.describe("Drop co-occurrence ties below this weight to focus on salient structure"),
			},
		},
		async ({ min_weight }) => {
			const graph = await entityGraph(supabase, { minWeight: min_weight });
			if (graph.nodes.length === 0) return "No entities yet — capture some thoughts first.";

			const weighted = toWeightedGraph(graph);
			const degree = weightedDegree(weighted);
			const community = communities(weighted);
			const bridges = crossCommunityEdges(weighted, community);

			const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
			const byDegree = (a: EntityNode, b: EntityNode) =>
				(degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name);

			// Group nodes by community, label each cluster by its most central member.
			const members = new Map<number, EntityNode[]>();
			for (const node of graph.nodes) {
				const c = community.get(node.id) ?? 0;
				const group = members.get(c);
				if (group) group.push(node);
				else members.set(c, [node]);
			}
			const labelOf = new Map<number, string>();
			for (const [c, group] of members) labelOf.set(c, [...group].sort(byDegree)[0].name);

			const multiMember = [...members.entries()]
				.filter(([, group]) => group.length >= 2)
				.sort(
					(a, b) =>
						b[1].length - a[1].length ||
						(labelOf.get(a[0]) ?? "").localeCompare(labelOf.get(b[0]) ?? ""),
				);
			const singletons = graph.nodes.length - multiMember.reduce((n, [, g]) => n + g.length, 0);

			const parts: string[] = [
				"# Knowledge Graph Overview",
				`${graph.nodes.length} entities · ${graph.edges.length} connections · ${members.size} clusters`,
			];

			// God nodes.
			const central = [...graph.nodes].sort(byDegree).slice(0, MAX_GOD_NODES);
			parts.push(
				"\n## Most central concepts",
				...central.map((n) => `• ${n.name} (${n.type}) — degree ${degree.get(n.id) ?? 0}`),
			);

			// Clusters.
			if (multiMember.length) {
				parts.push("\n## Clusters");
				for (const [c, group] of multiMember) {
					const names = [...group]
						.sort(byDegree)
						.slice(0, MAX_CLUSTER_MEMBERS)
						.map((n) => n.name);
					const more =
						group.length > MAX_CLUSTER_MEMBERS
							? `, +${group.length - MAX_CLUSTER_MEMBERS} more`
							: "";
					parts.push(
						`\n### ${labelOf.get(c)} (${group.length} entities)`,
						`${names.join(", ")}${more}`,
					);
				}
				if (singletons > 0)
					parts.push(
						`\n_${singletons} unconnected entit${singletons === 1 ? "y" : "ies"} omitted._`,
					);
			}

			// Surprising connections.
			if (bridges.length) {
				parts.push("\n## Surprising connections");
				for (const e of bridges.slice(0, MAX_BRIDGES)) {
					const s = nodeById.get(e.source);
					const t = nodeById.get(e.target);
					if (!s || !t) continue;
					const cs = labelOf.get(community.get(e.source) ?? -1);
					const ct = labelOf.get(community.get(e.target) ?? -1);
					parts.push(`• ${s.name} —${e.weight}×— ${t.name}  (links "${cs}" ↔ "${ct}")`);
				}
			}

			return parts.join("\n");
		},
	);
}

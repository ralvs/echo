import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { supabase } from "../config.ts";

export function registerGetThoughtContext(server: McpServer) {
	server.registerTool(
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
			try {
				const clampedDepth = Math.min(Math.max(depth, 1), 2);

				// Fetch the main thought
				const { data: thought, error: thoughtErr } = await supabase
					.from("thoughts")
					.select("id, content, metadata, created_at, event_at, category")
					.eq("id", thought_id)
					.single();

				if (thoughtErr || !thought) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Thought not found: ${thought_id}`,
							},
						],
						isError: true,
					};
				}

				// Fetch direct relations (depth 1)
				const { data: relations, error: relErr } = await supabase
					.from("thought_relations")
					.select(
						`
						relation_type, confidence, is_latest,
						source_id, target_id
					`,
					)
					.or(`source_id.eq.${thought_id},target_id.eq.${thought_id}`);

				if (relErr) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error fetching relations: ${relErr.message}`,
							},
						],
						isError: true,
					};
				}

				if (!relations || relations.length === 0) {
					const m = thought.metadata || {};
					return {
						content: [
							{
								type: "text" as const,
								text: `[Thought] ${thought.content}\n  Type: ${m.type || "unknown"} | Created: ${new Date(thought.created_at).toLocaleDateString()}${thought.event_at ? ` | Event: ${new Date(thought.event_at).toLocaleDateString()}` : ""}${thought.category ? ` | Category: ${thought.category}` : ""}\n\n  No relations found.`,
							},
						],
					};
				}

				// Collect related thought IDs
				const relatedIds = new Set<string>();
				for (const rel of relations) {
					if (rel.source_id !== thought_id) relatedIds.add(rel.source_id);
					if (rel.target_id !== thought_id) relatedIds.add(rel.target_id);
				}

				// Depth 2: fetch relations of related thoughts
				let depth2Relations: typeof relations = [];
				if (clampedDepth === 2 && relatedIds.size > 0) {
					const ids = [...relatedIds];
					const orFilter = ids.map((id) => `source_id.eq.${id},target_id.eq.${id}`).join(",");
					const { data: d2 } = await supabase
						.from("thought_relations")
						.select("relation_type, confidence, is_latest, source_id, target_id")
						.or(orFilter);
					if (d2) {
						depth2Relations = d2;
						for (const rel of d2) {
							if (rel.source_id !== thought_id) relatedIds.add(rel.source_id);
							if (rel.target_id !== thought_id) relatedIds.add(rel.target_id);
						}
					}
				}

				// Batch-fetch all related thoughts
				const { data: relatedThoughts } = await supabase
					.from("thoughts")
					.select("id, content, metadata, created_at, event_at, category")
					.in("id", [...relatedIds]);

				const thoughtMap: Record<
					string,
					{ content: string; metadata: Record<string, unknown>; created_at: string }
				> = {};
				if (relatedThoughts) {
					for (const t of relatedThoughts) {
						thoughtMap[t.id] = t;
					}
				}

				// Format output
				const m = thought.metadata || {};
				const parts = [
					`[Thought] ${thought.content}`,
					`  Type: ${m.type || "unknown"} | Created: ${new Date(thought.created_at).toLocaleDateString()}${thought.event_at ? ` | Event: ${new Date(thought.event_at).toLocaleDateString()}` : ""}${thought.category ? ` | Category: ${thought.category}` : ""}`,
					"",
					`Relations (${relations.length}):`,
				];

				for (const rel of relations) {
					const isSource = rel.source_id === thought_id;
					const otherId = isSource ? rel.target_id : rel.source_id;
					const direction = isSource ? "→" : "←";
					const other = thoughtMap[otherId];
					const latestTag = rel.is_latest === false ? " (superseded)" : "";
					const preview = other
						? other.content.length > 120
							? `${other.content.substring(0, 120)}...`
							: other.content
						: "(deleted)";

					parts.push(
						`  ${direction} ${rel.relation_type} (${(rel.confidence * 100).toFixed(0)}%${latestTag}): ${preview}`,
						`    ID: ${otherId}`,
					);
				}

				if (depth2Relations.length > 0) {
					parts.push("", `Extended relations (depth 2, ${depth2Relations.length}):`);
					for (const rel of depth2Relations) {
						// Skip relations already shown at depth 1
						if (rel.source_id === thought_id || rel.target_id === thought_id) continue;
						const source = thoughtMap[rel.source_id];
						const target = thoughtMap[rel.target_id];
						const srcPreview = source
							? source.content.substring(0, 60)
							: rel.source_id.substring(0, 8);
						const tgtPreview = target
							? target.content.substring(0, 60)
							: rel.target_id.substring(0, 8);
						parts.push(`  ${srcPreview}... → ${rel.relation_type} → ${tgtPreview}...`);
					}
				}

				return {
					content: [{ type: "text" as const, text: parts.join("\n") }],
				};
			} catch (err: unknown) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${(err as Error).message}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}

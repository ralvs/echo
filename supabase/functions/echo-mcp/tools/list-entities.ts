import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "../config.ts";

export function registerListEntities(server: McpServer) {
	server.registerTool(
		"list_entities",
		{
			title: "List Entities",
			description:
				"List entities in the knowledge graph — people, projects, organizations, tools, and places automatically extracted from captured thoughts. Sorted by how often they're mentioned. Optionally filter by type.",
			inputSchema: {
				type: z
					.enum(["person", "project", "organization", "tool", "place"])
					.optional()
					.describe("Filter to a single entity type"),
				limit: z.number().optional().default(30).describe("Max number of entities to return"),
			},
		},
		async ({ type, limit }) => {
			try {
				let query = supabase
					.from("entities")
					.select("id, type, canonical_name, mention_count")
					.order("mention_count", { ascending: false })
					.limit(limit);
				if (type) query = query.eq("type", type);

				const { data, error } = await query;
				if (error) {
					return {
						content: [{ type: "text" as const, text: `Error: ${error.message}` }],
						isError: true,
					};
				}

				if (!data?.length) {
					return {
						content: [
							{
								type: "text" as const,
								text: type ? `No ${type} entities yet.` : "No entities yet.",
							},
						],
					};
				}

				const lines = data.map(
					(e: { id: string; type: string; canonical_name: string; mention_count: number }) =>
						`• [${e.type}] ${e.canonical_name} — ${e.mention_count} mention(s) | ID: ${e.id}`,
				);

				return {
					content: [
						{
							type: "text" as const,
							text: `${data.length} entit${data.length === 1 ? "y" : "ies"}:\n\n${lines.join("\n")}`,
						},
					],
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

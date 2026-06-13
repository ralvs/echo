import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "../config.ts";
import { registerTextTool, ToolError } from "./contract.ts";

export function registerListEntities(server: McpServer) {
	registerTextTool(
		server,
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
			let query = supabase
				.from("entities")
				.select("id, type, canonical_name, mention_count")
				.order("mention_count", { ascending: false })
				.limit(limit);
			if (type) query = query.eq("type", type);

			const { data, error } = await query;
			if (error) throw new ToolError(`Error: ${error.message}`);

			if (!data?.length) {
				return type ? `No ${type} entities yet.` : "No entities yet.";
			}

			const lines = data.map(
				(e: { id: string; type: string; canonical_name: string; mention_count: number }) =>
					`• [${e.type}] ${e.canonical_name} — ${e.mention_count} mention(s) | ID: ${e.id}`,
			);

			return `${data.length} entit${data.length === 1 ? "y" : "ies"}:\n\n${lines.join("\n")}`;
		},
	);
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NON_BUNDLE_FILTER } from "../../_shared/thoughts-store.ts";
import { supabase } from "../config.ts";
import { preview, registerTextTool, ToolError } from "./contract.ts";

export function registerGetEntity(server: McpServer) {
	registerTextTool(
		server,
		"get_entity",
		{
			title: "Get Entity",
			description:
				"Retrieve a single entity by ID, or by name (optionally narrowed by type). Returns its compiled wiki page if one exists, the thoughts that mention it, and the entities it most often co-occurs with.",
			inputSchema: {
				id: z.string().optional().describe("Entity UUID"),
				name: z.string().optional().describe("Entity canonical name, e.g. 'Echo' or 'Andrea'"),
				type: z
					.enum(["person", "project", "organization", "tool", "place"])
					.optional()
					.describe("Narrow a name lookup to a single type"),
			},
		},
		async ({ id, name, type }) => {
			if (!id && !name) throw new ToolError("Error: provide either id or name.");

			let lookup = supabase
				.from("entities")
				.select("id, type, canonical_name, aliases, mention_count");
			if (id) {
				lookup = lookup.eq("id", id);
			} else {
				lookup = lookup.eq("canonical_name", name ?? "");
				if (type) lookup = lookup.eq("type", type);
			}

			const { data: entity, error } = await lookup.limit(1).maybeSingle();
			if (error || !entity) throw new ToolError(`Entity not found: ${id ?? name}`);

			const parts: string[] = [
				`# ${entity.canonical_name}`,
				`Type: ${entity.type} | Mentions: ${entity.mention_count} | ID: ${entity.id}`,
			];
			if (entity.aliases?.length) parts.push(`Aliases: ${(entity.aliases as string[]).join(", ")}`);

			// Compiled wiki page, if any.
			const { data: page } = await supabase
				.from("entity_pages")
				.select("summary, thought_count, related, updated_at")
				.eq("entity_id", entity.id)
				.maybeSingle();

			if (page) {
				parts.push(
					`\n## Wiki Page (${page.thought_count} thoughts, updated ${new Date(page.updated_at).toLocaleDateString()})\n${page.summary}`,
				);
				const related = (page.related ?? []) as { name: string; type: string; weight: number }[];
				if (related.length) {
					parts.push(
						`\n## Related\n${related.map((r) => `• ${r.name} (${r.type}, ${r.weight}×)`).join("\n")}`,
					);
				}
			}

			// Recent thoughts mentioning this entity.
			const { data: links } = await supabase
				.from("thought_entities")
				.select("thought_id")
				.eq("entity_id", entity.id)
				.limit(50);
			const thoughtIds = (links ?? []).map((l: { thought_id: string }) => l.thought_id);

			if (thoughtIds.length) {
				const { data: thoughts } = await supabase
					.from("thoughts")
					.select("id, content, created_at")
					.in("id", thoughtIds)
					.or(NON_BUNDLE_FILTER)
					.order("created_at", { ascending: false })
					.limit(10);

				if (thoughts?.length) {
					const lines = thoughts.map(
						(t: { content: string; created_at: string }) =>
							`• (${new Date(t.created_at).toLocaleDateString()}) ${preview(t.content, 160)}`,
					);
					parts.push(
						`\n## Thoughts (${thoughtIds.length} total, showing latest)\n${lines.join("\n")}`,
					);
				}
			}

			return parts.join("\n");
		},
	);
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { synthesizeUserProfile } from "../../_shared/profile.ts";
import { supabase } from "../config.ts";
import { ai } from "../model.ts";
import { registerTextTool } from "./contract.ts";

export function registerGetProfile(server: McpServer) {
	registerTextTool(
		server,
		"get_profile",
		{
			title: "Get User Profile",
			description:
				"Synthesize a structured user profile from captured thoughts. Returns stable facts & preferences (static) and recent activity & open tasks (dynamic). Optionally focus on a specific domain/topic.",
			inputSchema: {
				focus: z
					.string()
					.optional()
					.describe(
						"Optional domain or topic to emphasize in the profile (e.g. 'cooking', 'work', 'health')",
					),
			},
		},
		async ({ focus }) => {
			const result = await synthesizeUserProfile({ db: supabase, ai }, focus);
			if (result.kind === "empty") {
				return "Not enough captured thoughts to build a profile yet. Capture more facts, preferences, and daily notes first.";
			}
			return result.markdown;
		},
	);
}

import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
	const value = Deno.env.get(name);
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

export const SUPABASE_URL = requireEnv("SUPABASE_URL");
export const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
export const AI_GATEWAY_API_KEY = requireEnv("AI_GATEWAY_API_KEY");

export const AI_GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1";
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export const DECOMPOSE_MIN_TOKENS = Number(Deno.env.get("DECOMPOSE_MIN_TOKENS") || "200");
export const DECOMPOSE_ENABLED = Deno.env.get("DECOMPOSE_ENABLED") !== "false";

export const PRIORITY_LABELS: Record<number, string> = {
	0: "none",
	1: "low",
	2: "medium",
	3: "high",
	4: "urgent",
};

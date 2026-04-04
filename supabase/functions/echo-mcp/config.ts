import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
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

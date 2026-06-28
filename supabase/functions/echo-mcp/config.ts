import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
	const value = Deno.env.get(name);
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the Supabase
// platform into every edge function — never set manually via `supabase secrets
// set` (the CLI rejects any custom secret name starting with SUPABASE_).
export const SUPABASE_URL = requireEnv("SUPABASE_URL");
export const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

// Custom secret (not auto-injected, no SUPABASE_ prefix allowed): the
// project's publishable key, used only to validate caller-supplied OAuth
// access tokens (auth.getUser). Never used for data access — all DB calls go
// through the service-role client below.
export const ECHO_PUBLISHABLE_KEY = requireEnv("ECHO_PUBLISHABLE_KEY");

export const AI_GATEWAY_API_KEY = requireEnv("AI_GATEWAY_API_KEY");

// OAuth (Phase 2): the only Supabase Auth user allowed to use this MCP server.
// Even a successfully-authenticated, non-owner user is rejected — see index.ts.
export const ECHO_OWNER_USER_ID = requireEnv("ECHO_OWNER_USER_ID");

export const AI_GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1";
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export const supabaseAuthClient = createClient(SUPABASE_URL, ECHO_PUBLISHABLE_KEY);

export const DECOMPOSE_MIN_TOKENS = Number(Deno.env.get("DECOMPOSE_MIN_TOKENS") || "200");
export const DECOMPOSE_ENABLED = Deno.env.get("DECOMPOSE_ENABLED") !== "false";

export const PRIORITY_LABELS: Record<number, string> = {
	0: "none",
	1: "low",
	2: "medium",
	3: "high",
	4: "urgent",
};

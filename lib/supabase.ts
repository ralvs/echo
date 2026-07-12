import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

let _client: SupabaseClient | null = null;

export function getSupabase() {
	if (!_client) {
		_client = createClient(
			requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
			requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
		);
	}
	return _client;
}

export function createServiceClient() {
	return createClient(
		requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
		requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
	);
}

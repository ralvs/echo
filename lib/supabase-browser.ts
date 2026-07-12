import { createBrowserClient } from "@supabase/ssr";

/**
 * Cookie-backed browser client — auth state written here (login/logout) is
 * visible to the proxy and requireOwner(), unlike the localStorage-backed
 * client in lib/supabase.ts.
 *
 * Env vars are read as literal `process.env.NEXT_PUBLIC_*` expressions:
 * Next.js only inlines them into client bundles when accessed that way, so
 * requireEnv()'s dynamic lookup would be undefined in the browser.
 */
export function createBrowserSupabase() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
	if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_* env vars");
	return createBrowserClient(url, key);
}

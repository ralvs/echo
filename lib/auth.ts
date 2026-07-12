import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireEnv } from "@/lib/supabase";

/**
 * The security boundary (ADR-0020): every API route handler calls this before
 * touching the service-role client. The proxy only refreshes cookies and
 * redirects page loads; it never gates the API.
 *
 * Usage — first line of every handler, before parsing the body or scheduling
 * `after()` work:
 *   const auth = await requireOwner();
 *   if (auth instanceof NextResponse) return auth;
 */
export async function requireOwner(): Promise<User | NextResponse> {
	const cookieStore = await cookies();

	const supabase = createServerClient(
		requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
		requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
		{
			cookies: {
				getAll() {
					return cookieStore.getAll();
				},
				// The proxy owns token refresh; a second writer here would race
				// refresh-token rotation on concurrent requests.
				setAll() {},
			},
		},
	);

	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user || user.id !== requireEnv("ECHO_OWNER_USER_ID")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	return user;
}

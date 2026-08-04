import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

/**
 * UX + session upkeep only — never the security boundary (ADR-0020). The one
 * job that must live here: refreshing expired tokens, because this is the
 * single writer of rotated refresh-token cookies. API authz stays in
 * requireOwner() inside each route handler.
 */
export async function proxy(request: NextRequest) {
	// setAll rebuilds this response so refreshed cookies reach BOTH the
	// downstream handler (via request) and the browser (via response).
	let response = NextResponse.next({ request });

	const supabase = createServerClient(
		// biome-ignore lint/style/noNonNullAssertion: edge runtime; requireEnv would drag in supabase-js
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		// biome-ignore lint/style/noNonNullAssertion: same
		process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
		{
			cookies: {
				getAll() {
					return request.cookies.getAll();
				},
				setAll(cookiesToSet) {
					for (const { name, value } of cookiesToSet) {
						request.cookies.set(name, value);
					}
					response = NextResponse.next({ request });
					for (const { name, value, options } of cookiesToSet) {
						response.cookies.set(name, value, options);
					}
				},
			},
		},
	);

	// Nothing may run between client creation and getUser(): this call
	// refreshes the token and triggers setAll above.
	const {
		data: { user },
	} = await supabase.auth.getUser();

	const { pathname } = request.nextUrl;
	const isApi = pathname.startsWith("/api");
	// Fail closed if the env var is unset — otherwise a sessionless request
	// would match undefined === undefined and skip the redirect.
	const ownerId = process.env.ECHO_OWNER_USER_ID;
	const isOwner = !!ownerId && user?.id === ownerId;

	// Redirect only page navigations; API requests fall through so client
	// fetch() gets a JSON 401 from requireOwner(), not an HTML redirect.
	if (!isApi && !isOwner) {
		const url = request.nextUrl.clone();
		url.pathname = "/login";
		const redirect = NextResponse.redirect(url);
		for (const c of response.cookies.getAll()) redirect.cookies.set(c);
		return redirect;
	}

	return response;
}

export const config = {
	matcher: [
		// Everything except /login, the OAuth surface, Next internals, and
		// static assets. /api is otherwise deliberately INCLUDED so token
		// refresh happens here, serially.
		//
		// The OAuth exclusions are load-bearing, and all three fail *silently*
		// if dropped — this matcher is the "matcher drift" hazard ADR-0020
		// names, so re-check them when touching this line:
		//   .well-known    discovery is read before the client has any token;
		//                  redirecting it to /login returns HTML where a
		//                  client demands JSON, and only Claude (which follows
		//                  the WWW-Authenticate hint instead) keeps working.
		//   oauth/consent  the user is by definition not signed in when they
		//                  arrive — the page runs its own login — so a
		//                  redirect to /login strands the whole flow.
		//   api/mcp        bearer-authenticated, never cookie-authenticated;
		//                  it must not participate in dashboard sessions.
		"/((?!_next/static|_next/image|favicon.ico|login|\\.well-known|oauth/consent|api/mcp|api/oauth|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
	],
};

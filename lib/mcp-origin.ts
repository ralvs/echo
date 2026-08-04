import type { NextRequest } from "next/server";

/**
 * Shared shape for the MCP resource server that fronts the Supabase edge
 * function. Both the discovery document and the proxy have to agree on these
 * strings exactly — RFC 9728 clients compare the `resource` they discovered
 * against the URL they connected to, and reject a mismatch.
 */

/** Path the MCP endpoint is served from, relative to this app's root. */
export const MCP_PATH = "/api/mcp";

/** Where the discovery document answers (see the rewrites in next.config.ts). */
export const PRM_PATH = "/.well-known/oauth-protected-resource";

/**
 * Derived from the forwarded host rather than an env var, so the same build
 * serves the vercel.app URL and a custom domain, and moving to a new domain
 * needs no code change or redeploy. Vercel terminates TLS upstream, so
 * x-forwarded-* is authoritative here and request.url is not.
 */
export function originOf(request: NextRequest): string {
	const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
	const proto = request.headers.get("x-forwarded-proto") ?? "https";
	return `${proto}://${host}`;
}

/** The `WWW-Authenticate` challenge pointing clients at our discovery document. */
export function bearerChallenge(origin: string): string {
	return `Bearer resource_metadata="${origin}${PRM_PATH}"`;
}

/**
 * CORS for every MCP-facing route. Browser clients (Claude web/mobile) cannot
 * connect without it; native ones never send a preflight, which is why its
 * absence stayed invisible for so long.
 *
 * Origin "*" is safe here and must stay uncredentialed: auth is a bearer token
 * the client holds, never a cookie, so an allowed origin gains nothing it
 * could not already do. Adding credentials would both void the wildcard and
 * start honouring ambient dashboard cookies on this origin — which is exactly
 * the confusion this endpoint must avoid, since it shares a domain with the
 * cookie-authenticated dashboard.
 *
 * WWW-Authenticate is exposed because it carries the discovery hint, and
 * browsers hide unlisted response headers from client JS.
 */
export const MCP_CORS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
	"Access-Control-Allow-Headers":
		"authorization,content-type,accept,mcp-protocol-version,mcp-session-id,last-event-id",
	"Access-Control-Expose-Headers": "WWW-Authenticate,mcp-session-id",
	"Access-Control-Max-Age": "86400",
};

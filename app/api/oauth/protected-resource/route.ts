import { type NextRequest, NextResponse } from "next/server";
import { MCP_CORS, MCP_PATH, originOf } from "@/lib/mcp-origin";
import { requireEnv } from "@/lib/supabase";

/**
 * RFC 9728 Protected Resource Metadata — the document that tells an OAuth
 * client which authorization server guards this MCP endpoint.
 *
 * Unauthenticated by design: a client reads this *before* it has a token, so
 * it must be excluded from the proxy's session redirect (see proxy.ts). If
 * this ever starts returning a 307 to /login instead of JSON, discovery is
 * broken again and only Claude will still connect.
 *
 * Reached via the /.well-known rewrites in next.config.ts, in both the root
 * and path-inserted spellings — the two locations real clients probe.
 */

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
	const origin = originOf(request);
	return NextResponse.json(
		{
			resource: `${origin}${MCP_PATH}`,
			authorization_servers: [`${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}/auth/v1`],
			scopes_supported: ["openid"],
			bearer_methods_supported: ["header"],
		},
		{ headers: MCP_CORS },
	);
}

export function OPTIONS() {
	return new NextResponse(null, { status: 204, headers: MCP_CORS });
}

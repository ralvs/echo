import { type NextRequest, NextResponse } from "next/server";
import { bearerChallenge, MCP_CORS, originOf } from "@/lib/mcp-origin";
import { requireEnv } from "@/lib/supabase";

/**
 * Thin proxy to the echo-mcp edge function.
 *
 * The MCP server itself still lives in Supabase — this route exists only so
 * the endpoint sits at a domain root we control, which is what makes RFC 9728
 * discovery possible (see next.config.ts). Keeping the implementation upstream
 * means the Supabase URL keeps working for already-connected clients.
 *
 * This route must NOT call requireOwner(). The dashboard's cookie session is
 * deliberately not an authentication path here: MCP clients authenticate with
 * a bearer token, and the edge function is the single place that validates it
 * against the owner allowlist. Only the Authorization header is forwarded —
 * cookies are dropped so a logged-in browser can never silently authorize an
 * MCP call it did not present a token for.
 */

export const dynamic = "force-dynamic";

/** Forwarded verbatim; everything else (notably cookie) is dropped. */
const FORWARD_HEADERS = [
	"authorization",
	"content-type",
	"accept",
	"mcp-protocol-version",
	"mcp-session-id",
	"last-event-id",
];

function upstreamUrl(): string {
	return `${requireEnv("NEXT_PUBLIC_SUPABASE_URL")}/functions/v1/echo-mcp`;
}

function forwardHeaders(request: NextRequest): Headers {
	const headers = new Headers();
	for (const name of FORWARD_HEADERS) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

async function proxy(request: NextRequest, body?: BodyInit): Promise<NextResponse> {
	let upstream: Response;
	try {
		upstream = await fetch(upstreamUrl(), {
			method: request.method,
			headers: forwardHeaders(request),
			body,
			// Streamable HTTP may answer with text/event-stream; don't buffer.
			redirect: "manual",
		});
	} catch (err) {
		return NextResponse.json(
			{ error: `Upstream MCP server unreachable: ${(err as Error).message}` },
			{ status: 502, headers: MCP_CORS },
		);
	}

	const headers = new Headers(MCP_CORS);
	for (const name of ["content-type", "mcp-session-id"]) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}

	// Rewrite rather than forward: upstream's challenge advertises the Supabase
	// discovery URL, which is the unreachable one. Clients must be sent to the
	// document this app serves, or they end up back at the broken path.
	if (upstream.status === 401) {
		headers.set("WWW-Authenticate", bearerChallenge(originOf(request)));
	}

	return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export async function POST(request: NextRequest) {
	return proxy(request, await request.arrayBuffer());
}

// Streamable HTTP uses GET to open the server->client stream and DELETE to end
// a session. The edge function answers 405 to both today; proxying them keeps
// this route honest if that changes, instead of masking it with our own 405.
export async function GET(request: NextRequest) {
	return proxy(request);
}

export async function DELETE(request: NextRequest) {
	return proxy(request);
}

export function OPTIONS() {
	return new NextResponse(null, { status: 204, headers: MCP_CORS });
}

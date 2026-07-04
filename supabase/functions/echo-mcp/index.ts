import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Context, Hono } from "hono";
import { ECHO_OWNER_USER_ID, SUPABASE_URL, supabaseAuthClient } from "./config.ts";
import { registerCaptureThought } from "./tools/capture-thought.ts";
import { registerDeleteThought } from "./tools/delete-thought.ts";
import { registerFindPath } from "./tools/find-path.ts";
import { registerGetEntity } from "./tools/get-entity.ts";
import { registerGetProfile } from "./tools/get-profile.ts";
import { registerGetThoughtContext } from "./tools/get-thought-context.ts";
import { registerGetTopicPage } from "./tools/get-topic-page.ts";
import { registerGraphOverview } from "./tools/graph-overview.ts";
import { registerLintThoughts } from "./tools/lint-thoughts.ts";
import { registerListDue } from "./tools/list-due.ts";
import { registerListEntities } from "./tools/list-entities.ts";
import { registerListThoughts } from "./tools/list-thoughts.ts";
import { registerListTopicPages } from "./tools/list-topic-pages.ts";
import { registerRefreshEntityPage } from "./tools/refresh-entity-page.ts";
import { registerRefreshTopicPage } from "./tools/refresh-topic-page.ts";
import { registerResolveThought } from "./tools/resolve-thought.ts";
import { registerSearchThoughts } from "./tools/search-thoughts.ts";
import { registerThoughtStats } from "./tools/thought-stats.ts";
import { registerUpdateThought } from "./tools/update-thought.ts";

// --- MCP Server Factory (stateless: new instance per request) ---

function createServer(): McpServer {
	const server = new McpServer({
		name: "echo",
		version: "6.0.0",
	});

	registerSearchThoughts(server);
	registerListThoughts(server);
	registerThoughtStats(server);
	registerCaptureThought(server);
	registerUpdateThought(server);
	registerDeleteThought(server);
	registerResolveThought(server);
	registerListDue(server);
	registerGetThoughtContext(server);
	registerGetProfile(server);
	registerListTopicPages(server);
	registerGetTopicPage(server);
	registerRefreshTopicPage(server);
	registerLintThoughts(server);
	registerListEntities(server);
	registerGetEntity(server);
	registerRefreshEntityPage(server);
	registerFindPath(server);
	registerGraphOverview(server);

	return server;
}

// --- Hono App ---
// Auth: Authorization: Bearer <Supabase OAuth access token> — validated against
// Supabase Auth and required to belong to ECHO_OWNER_USER_ID. All MCP clients
// connect via the OAuth+PKCE flow against Supabase Auth's OAuth 2.1 server
// (see echo-consent for the login/consent UI). Scripts/hooks talk to the DB
// directly with the service-role key and never hit this endpoint.
// Secret key is used only internally for DB access — never exposed in client config.
// verify_jwt = false — the check above replaces the gateway's own JWT verification.

const RESOURCE_METADATA_PATH = "/echo-mcp/.well-known/oauth-protected-resource";
const RESOURCE_METADATA_URL = `${SUPABASE_URL}/functions/v1${RESOURCE_METADATA_PATH}`;
const MCP_RESOURCE_URL = `${SUPABASE_URL}/functions/v1/echo-mcp`;

const app = new Hono().basePath("/echo-mcp");

// RFC 9728 Protected Resource Metadata — unauthenticated, tells OAuth clients
// (Claude) which authorization server to use for this MCP resource.
app.get("/.well-known/oauth-protected-resource", (c) => {
	return c.json({
		resource: MCP_RESOURCE_URL,
		authorization_servers: [`${SUPABASE_URL}/auth/v1`],
		scopes_supported: ["openid"],
		bearer_methods_supported: ["header"],
	});
});

function unauthorized(c: Context) {
	c.header("WWW-Authenticate", `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`);
	return c.json({ error: "Unauthorized" }, 401);
}

app.all("/", async (c) => {
	if (c.req.method !== "POST") {
		return c.json({ error: "Method not allowed" }, 405);
	}

	const authHeader = c.req.header("authorization");
	const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
	if (!token) {
		return unauthorized(c);
	}

	const { data, error } = await supabaseAuthClient.auth.getUser(token);
	if (error || !data.user || data.user.id !== ECHO_OWNER_USER_ID) {
		return unauthorized(c);
	}

	const server = createServer();
	const transport = new StreamableHTTPTransport();
	await server.connect(transport);
	return transport.handleRequest(c);
});

Deno.serve(app.fetch);

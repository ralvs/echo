import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { registerCaptureThought } from "./tools/capture-thought.ts";
import { registerDeleteThought } from "./tools/delete-thought.ts";
import { registerFindPath } from "./tools/find-path.ts";
import { registerGetEntity } from "./tools/get-entity.ts";
import { registerGetProfile } from "./tools/get-profile.ts";
import { registerGetThoughtContext } from "./tools/get-thought-context.ts";
import { registerGetTopicPage } from "./tools/get-topic-page.ts";
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

	return server;
}

// --- Hono App ---
// Auth: Authorization: Bearer <publishable_key> (MCP_PUBLISHABLE_KEY secret).
// Secret key is used only internally for DB access — never exposed in client config.
// verify_jwt = false — Supabase gateway MCP auth support is not yet available.

const app = new Hono().basePath("/echo-mcp");

app.all("/", async (c) => {
	if (c.req.method !== "POST") {
		return c.json({ error: "Method not allowed" }, 405);
	}

	const authHeader = c.req.header("authorization");
	const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
	if (!token || token !== Deno.env.get("MCP_PUBLISHABLE_KEY")) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const server = createServer();
	const transport = new StreamableHTTPTransport();
	await server.connect(transport);
	return transport.handleRequest(c);
});

Deno.serve(app.fetch);

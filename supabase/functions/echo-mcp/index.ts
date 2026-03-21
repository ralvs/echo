import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";

import { MCP_ACCESS_KEY } from "./config.ts";
import { registerSearchThoughts } from "./tools/search-thoughts.ts";
import { registerListThoughts } from "./tools/list-thoughts.ts";
import { registerThoughtStats } from "./tools/thought-stats.ts";
import { registerCaptureThought } from "./tools/capture-thought.ts";
import { registerUpdateThought } from "./tools/update-thought.ts";
import { registerDeleteThought } from "./tools/delete-thought.ts";
import { registerResolveThought } from "./tools/resolve-thought.ts";
import { registerListDue } from "./tools/list-due.ts";

// --- MCP Server Factory (stateless: new instance per request) ---

function createServer(): McpServer {
	const server = new McpServer({
		name: "echo",
		version: "3.0.0",
	});

	registerSearchThoughts(server);
	registerListThoughts(server);
	registerThoughtStats(server);
	registerCaptureThought(server);
	registerUpdateThought(server);
	registerDeleteThought(server);
	registerResolveThought(server);
	registerListDue(server);

	return server;
}

// --- Hono App with Auth Check ---

const app = new Hono().basePath("/echo-mcp");

app.all("/", async (c) => {
	if (c.req.method !== "POST") {
		return c.json({ error: "Method not allowed" }, 405);
	}

	const provided = c.req.header("x-echo-key") || new URL(c.req.url).searchParams.get("key");
	if (!provided || provided !== MCP_ACCESS_KEY) {
		return c.json({ error: "Invalid or missing access key" }, 401);
	}

	const server = createServer();
	const transport = new StreamableHTTPTransport();
	await server.connect(transport);
	return transport.handleRequest(c);
});

Deno.serve(app.fetch);

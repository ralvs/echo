/**
 * The tool adapter contract. Every MCP tool registers through
 * registerTextTool(), which owns the response envelope, the error
 * translation, and the shared preview truncation — so the 17 tool files
 * contain only domain logic that produces a string.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

/**
 * Domain failure (not found, bad input, …): rendered verbatim with
 * isError, without the generic "Error:" prefix unexpected throws get.
 */
export class ToolError extends Error {}

/** One truncation style for every thought preview a tool renders. */
export function preview(text: string, maxLen = 120): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

export function registerTextTool<Schema extends z.ZodRawShape>(
	server: McpServer,
	name: string,
	config: { title: string; description: string; inputSchema: Schema },
	run: (args: Parameters<ToolCallback<Schema>>[0]) => Promise<string>,
): void {
	// The wrapper is the one trusted seam: callers get a precisely-typed `run`,
	// while the constructed callback is cast past TS's generic-callback
	// assignability limitation (ShapeOutput<Schema> can't reduce under an open Schema).
	const callback = (async (args: Parameters<ToolCallback<Schema>>[0]) => {
		try {
			return { content: [{ type: "text" as const, text: await run(args) }] };
		} catch (err: unknown) {
			const text = err instanceof ToolError ? err.message : `Error: ${(err as Error).message}`;
			return { content: [{ type: "text" as const, text }], isError: true };
		}
	}) as unknown as ToolCallback<Schema>;
	server.registerTool(name, config, callback);
}

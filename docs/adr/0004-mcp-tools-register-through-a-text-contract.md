# MCP tools register through `registerTextTool`; `ToolError` renders verbatim

Every MCP tool registers via `registerTextTool` in `echo-mcp/tools/contract.ts`: the handler returns a plain `string`, and the contract owns the response envelope, the error translation, and the shared `preview()` truncation. A thrown `ToolError` is rendered verbatim (domain failures like "Thought not found"); any other error is prefixed with `Error:`. New tools follow this contract rather than hand-building `{ content: [{ type: "text", … }] }`.

## Considered options

The envelope, try/catch, and preview truncation were copy-pasted across all 17 tools, having already drifted to three truncation lengths and two ellipsis characters. Collapsing them into the contract removed ~285 lines and made the response shape changeable in one place.

## Consequences

- `registerTextTool` casts its constructed callback `as unknown as ToolCallback<Schema>`. This is **deliberate**: TypeScript can't prove a concrete callback satisfies the SDK's `ShapeOutput<Schema>` under an open generic. The cast lives only in the one trusted wrapper; callers still get a precisely-typed `run`. Do not "fix" it by widening the public types.
- Use `ToolError` for expected, user-facing failures you want shown as-is; let everything else throw normally to get the generic prefix and `isError: true`.

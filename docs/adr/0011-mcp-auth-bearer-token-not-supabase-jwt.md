# MCP auth is a bearer token in Hono middleware, with `verify_jwt = false`

The `echo-mcp` edge function sets `verify_jwt = false` in `config.toml` and authenticates requests itself: Hono middleware checks `Authorization: Bearer <token>` against the `MCP_PUBLISHABLE_KEY` secret. The Supabase service-role key is used only for internal DB access and is never sent to clients.

## Why this is recorded

`verify_jwt = false` reads like a security hole — the obvious assumption is that auth was disabled. It wasn't: Supabase's gateway-level auth can't validate the custom bearer token an MCP client sends (MCP-level JWT auth isn't available yet), so the check **had** to move into application middleware, which forces `verify_jwt = false` at the gateway. The two settings are a pair, not an oversight.

## Consequences

- Don't "re-enable" `verify_jwt`; it would reject the MCP client's bearer token before the middleware ever runs.
- This is sufficient for a single-user personal deployment. Revisit (real per-user JWT) only if Echo becomes multi-tenant or Supabase ships gateway MCP auth.

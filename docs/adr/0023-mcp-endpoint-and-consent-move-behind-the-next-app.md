# The MCP endpoint and the consent page move behind the Next.js app

Clients connect to `https://<domain>/api/mcp`, a thin proxy in the Next.js app
that forwards to the `echo-mcp` edge function, and the OAuth login + consent
screen moves from the standalone `consent/` Vercel project to
`app/oauth/consent`. The edge function remains the implementation and keeps
serving its own URL; the Supabase Auth OAuth server is unchanged.

## Why this is recorded

An MCP server on `*.supabase.co` is reachable only at a sub-path
(`/functions/v1/echo-mcp`), but RFC 9728 and RFC 8414 discovery answer at the
**origin root** — which belongs to Supabase's gateway. Measured against the
live project, exactly one of eight discovery paths resolved:

| Path | Status |
| --- | --- |
| `/functions/v1/echo-mcp/.well-known/oauth-protected-resource` | 200 (non-standard, path-suffixed) |
| `/.well-known/oauth-protected-resource/functions/v1/echo-mcp` | 401 (RFC 9728 §3.1 canonical) |
| `/.well-known/oauth-protected-resource` | 404 |
| `/.well-known/oauth-authorization-server` | 404 |
| `/.well-known/openid-configuration` | 404 |

Claude connected anyway because it follows the `resource_metadata` hint in the
`WWW-Authenticate` challenge rather than probing well-known locations. Clients
that do standard server-side discovery (Grok) found nothing and failed before
ever reaching dynamic client registration — no client was ever registered for
them, which is what localised the failure to discovery rather than to auth.
The symptom was a 500 from the *client's* backend, not an error from ours,
which is why it read as "unavailable" rather than as a spec problem.

A Supabase custom domain does not fix this: the function still lives under
`/functions/v1/`, so the canonical path still resolves against the gateway.
Serving the metadata from a root we already control does fix it, for every
client at once.

`resource` is derived from the forwarded host rather than an env var, so one
build serves the `vercel.app` URL and the custom domain identically and a
later domain move needs no code change. The value is still load-bearing:
clients compare the discovered `resource` against the URL they connected to,
so changing domains forces re-authorization regardless.

## Why the consent page came along

ADR-0019 recorded that the consent page could not be a Supabase Edge Function
— the gateway rewrites `text/html` to `text/plain` on `*.supabase.co` and
applies a hard sandbox CSP. That argued against hosting it *on Supabase*, not
for a separate Vercel project; the standalone deployment was justified
separately as carrying "no meaningful attack surface" because it had zero
other routes. ADR-0020 undercuts that: the dashboard already exposes a public
login form authenticating the same Owner account against the same Supabase
Auth, so consolidating adds no new credential exposure. One origin for the
whole OAuth surface is what makes root-level discovery possible at all.

## Consequences

- CORS is now mandatory on anything MCP-facing. Native clients never send a
  preflight, so its absence was invisible until a browser client tried to
  connect. Origin `*` is correct here and must stay **uncredentialed**: auth is
  a client-held bearer token, never a cookie. Adding credentials would void the
  wildcard and start honouring ambient dashboard cookies — a real hazard now
  that the MCP route shares an origin with the cookie-authenticated dashboard.
  `/api/mcp` therefore forwards only the `Authorization` header and drops
  cookies; it must never call `requireOwner()`.
- The proxy rewrites the upstream `WWW-Authenticate` instead of forwarding it.
  The edge function advertises the Supabase discovery URL, which is the
  unreachable one; clients must be pointed at the document this app serves.
- Three middleware exclusions in `proxy.ts` are load-bearing and fail
  *silently*: `.well-known` and `oauth/consent` are both reached with no
  session by definition, and would otherwise be redirected to `/login` —
  returning HTML where a client demands JSON. This is exactly the matcher-drift
  hazard ADR-0020 names.
- Porting the consent page surfaced two latent bugs, both silent because the
  old page read fields that never existed: `scopes` (the field is `scope`, one
  space-separated string) rendered an empty scope list on every consent screen,
  and `client_name`/`client_id` (the fields are `name`/`id`) rendered a blank
  client name — the owner was approving an unnamed client. The
  already-consented `OAuthRedirect` branch was also unhandled.
- The edge function keeps its own auth, CORS, and metadata endpoint and stays
  directly reachable. That is deliberate: it is the implementation, not a
  legacy path, and leaving its URL working means already-connected clients are
  unaffected by this change.

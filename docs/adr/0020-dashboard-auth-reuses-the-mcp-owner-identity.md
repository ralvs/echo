# Dashboard auth reuses the MCP Owner identity, enforced in the routes

The deployed dashboard (Vercel) is gated by Supabase Auth using the same single
Owner account that already gates MCP OAuth (ADR-0019's `ECHO_OWNER_USER_ID`
allowlist), not by Vercel's platform-level Deployment Protection. The whole
system converges on one domain statement: Echo trusts exactly one Supabase Auth
user, on every transport.

The security boundary lives in the API route handlers — each of the four
`app/api/*` routes calls a `requireOwner()` helper (session from cookies via
`@supabase/ssr`, then `user.id === ECHO_OWNER_USER_ID`) before touching the
service-role client. Next.js middleware exists only for UX (redirecting
sessionless page loads to `/login`); a middleware matcher gap therefore
degrades to an ugly 401, not a breach. This route-level placement is
deliberate: middleware-only auth is the layer that historically breaks
(matcher drift, header-trust bugs like CVE-2025-29927).

## Considered options

- **Vercel Authentication (Deployment Protection)** — zero code, but ties
  access to a Vercel SSO session (worse on iOS Safari), leaves the API routes
  themselves zero-auth behind a platform toggle, and splits the trust model
  into "Supabase user for MCP, Vercel session for dashboard."
- **Middleware-only Supabase Auth** — fewer call sites, but makes the matcher
  config the security boundary.

## Consequences

- Login is email/password with the existing Owner account (same credentials as
  the OAuth consent page); Supabase's leaked-password protection should be
  enabled since this password is now the front door.
- No rate limiting on `POST /api/thoughts`: once only the Owner can call it,
  the unauthenticated AI-gateway cost-abuse scenario is gone.
- Adding a second user or a share link later means replacing the single-id
  check in `requireOwner()` — same seam ADR-0019 already names for the MCP
  path.

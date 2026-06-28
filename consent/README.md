# echo-consent

Standalone login + consent screen for Supabase Auth's OAuth 2.1 server, used by the Echo MCP custom connector (Claude Desktop / iOS).

## Why this is its own project

Supabase's edge gateway force-rewrites `text/html` responses to `text/plain` on the default `*.supabase.co` domain (an anti-phishing guardrail) and applies a hard `sandbox` CSP — so this page can't be hosted as a Supabase Edge Function without paying for a custom domain. It's deployed here instead, as a single static page with **zero other routes**: there is nothing on this deployment besides a login form and an "Allow access?" screen, so it carries no meaningful attack surface even though it's publicly reachable. It is **not** part of the main Echo dashboard and shares no code or routes with it.

## How it works

- `index.html` is a template with two placeholders: `__SUPABASE_URL__` and `__ECHO_PUBLISHABLE_KEY__`.
- `build.mjs` substitutes them from env vars at build time and writes the result to `dist/index.html`. Both values are intentionally public — the publishable key is designed to be exposed in browsers — so nothing secret is baked in.
- All Supabase calls happen client-side: sign in, then `supabase.auth.oauth.getAuthorizationDetails` / `approveAuthorization` / `denyAuthorization`.
- No backend, no API routes, no framework — `vercel.json` just runs `node build.mjs` and serves the `dist/` folder as static files.

## Deploy

```bash
cd consent
vercel link        # first time only — create/link a separate Vercel project, e.g. "echo-consent"
vercel env add SUPABASE_URL production       # paste https://<project-ref>.supabase.co
vercel env add ECHO_PUBLISHABLE_KEY production  # paste the sb_publishable_... key
vercel --prod
```

After deploying, point Supabase at this URL:

- **Authentication → URL Configuration → Site URL**: the deployed domain (e.g. `https://echo-consent.vercel.app`)
- **Authentication → OAuth Server → Authorization Path**: `/` (this project has only one page)

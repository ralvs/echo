import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// RFC 9728 discovery has to answer at the domain ROOT, which is the whole
	// reason the MCP server moved behind this app: on *.supabase.co the root
	// belongs to Supabase's gateway, so every canonical well-known path 401s
	// or 404s and only Claude (which follows the WWW-Authenticate hint) could
	// connect.
	//
	// These are rewrites rather than an `app/.well-known/` directory because
	// dot-prefixed segments are not reliably picked up by the filesystem
	// router. Both spellings are served: the root form, and the path-inserted
	// form (RFC 9728 §3.1) that strict clients derive from the resource path.
	async rewrites() {
		return [
			{
				source: "/.well-known/oauth-protected-resource",
				destination: "/api/oauth/protected-resource",
			},
			{
				source: "/.well-known/oauth-protected-resource/:path*",
				destination: "/api/oauth/protected-resource",
			},
		];
	},
};

export default nextConfig;

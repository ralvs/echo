"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { createBrowserSupabase } from "@/lib/supabase-browser";

/**
 * OAuth login + consent screen for Supabase Auth's OAuth 2.1 server, reached
 * when an MCP client (Claude, or any DCR-capable client) starts an
 * authorization request.
 *
 * Consolidated from the former standalone consent/ Vercel project. That
 * project existed because Supabase's edge gateway rewrites text/html to
 * text/plain on *.supabase.co — a reason it could not be an *edge function*,
 * not a reason it needed its own deployment. It lives here now so the OAuth
 * surface and the MCP endpoint share one origin, which is what lets RFC 9728
 * discovery answer at the domain root.
 *
 * Visitors arrive signed-out by definition, so this route is excluded from the
 * proxy's session redirect (see proxy.ts). Unlike the old standalone page this
 * uses the cookie-backed browser client, so an owner already signed into the
 * dashboard skips the password step.
 */

const loginSchema = z.object({
	email: z.string().email("Enter a valid email"),
	password: z.string().min(1, "Password is required"),
});

type LoginForm = z.infer<typeof loginSchema>;

type AuthorizationDetails = {
	clientName: string;
	scopes: string[];
};

type View = "loading" | "login" | "consent" | "done";

export default function OAuthConsentPage() {
	const [view, setView] = useState<View>("loading");
	const [details, setDetails] = useState<AuthorizationDetails | null>(null);
	const [authError, setAuthError] = useState<string | null>(null);
	const [consentError, setConsentError] = useState<string | null>(null);
	const [deciding, setDeciding] = useState(false);
	const [authorizationId, setAuthorizationId] = useState<string | null>(null);

	const {
		register,
		handleSubmit,
		formState: { errors, isSubmitting },
	} = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

	// Read on the client only: this value is a query param, and touching
	// useSearchParams would force a Suspense boundary for no benefit.
	useEffect(() => {
		setAuthorizationId(new URLSearchParams(window.location.search).get("authorization_id"));
	}, []);

	const loadAuthorization = useCallback(async (id: string) => {
		const supabase = createBrowserSupabase();
		const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
		if (error || !data) {
			setConsentError(error?.message ?? "Could not load the authorization request.");
			setView("consent");
			return;
		}
		// Two-shape response. Without consent details it means Supabase
		// auto-approved (the user already granted these scopes), and the only
		// correct move is to hand control straight back to the client — the old
		// standalone page ignored this branch and showed an empty consent card.
		if (!("authorization_id" in data)) {
			setView("done");
			window.location.replace(data.redirect_url);
			return;
		}
		setDetails({
			// Fields are `name`/`id`. The old page read `client_name`/`client_id`,
			// neither of which exists, so the consent screen asked the owner to
			// approve a connection from a blank name.
			clientName: data.client.name || data.client.id,
			// `scope` is one space-separated string, not an array. The old page
			// read `data.scopes`, which is always undefined, so it silently
			// rendered an empty list on every consent screen.
			scopes: data.scope.split(/\s+/).filter(Boolean),
		});
		setView("consent");
	}, []);

	useEffect(() => {
		if (authorizationId === null) return;
		if (!authorizationId) {
			setAuthError("Missing authorization request. Try connecting again from your MCP client.");
			setView("login");
			return;
		}
		(async () => {
			const supabase = createBrowserSupabase();
			const { data } = await supabase.auth.getSession();
			if (data.session) {
				await loadAuthorization(authorizationId);
			} else {
				setView("login");
			}
		})();
	}, [authorizationId, loadAuthorization]);

	const onSubmit = async ({ email, password }: LoginForm) => {
		if (!authorizationId) return;
		setAuthError(null);
		const supabase = createBrowserSupabase();
		const { error } = await supabase.auth.signInWithPassword({ email, password });
		if (error) {
			setAuthError("Invalid email or password.");
			return;
		}
		await loadAuthorization(authorizationId);
	};

	const decide = async (approve: boolean) => {
		if (!authorizationId) return;
		setDeciding(true);
		setConsentError(null);
		const supabase = createBrowserSupabase();
		const { data, error } = approve
			? await supabase.auth.oauth.approveAuthorization(authorizationId)
			: await supabase.auth.oauth.denyAuthorization(authorizationId);

		if (error || !data?.redirect_url) {
			setConsentError(error?.message ?? "Could not complete the request.");
			setDeciding(false);
			return;
		}
		setView("done");
		// Hands control back to the MCP client with the auth code.
		window.location.replace(data.redirect_url);
	};

	const inputClass =
		"w-full bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-active transition-colors";
	const errorClass =
		"text-xs text-danger bg-danger/10 border border-danger/25 rounded-[var(--radius-sm)] px-3 py-2";

	return (
		<div className="min-h-screen flex items-center justify-center px-6">
			<motion.div
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.4, ease: "easeOut" }}
				className="w-full max-w-sm"
			>
				<div className="flex flex-col items-center mb-8">
					<div className="relative w-14 h-14 flex items-center justify-center mb-4">
						<div className="absolute inset-0 rounded-full bg-amber-glow/20" />
						<div className="absolute inset-[10px] rounded-full bg-amber-glow/40" />
						<div className="absolute inset-[18px] rounded-full bg-amber-glow" />
					</div>
					<h1 className="font-display text-3xl text-text-primary tracking-wide">Echo</h1>
				</div>

				<div className="bg-surface-1 border border-border-subtle rounded-[var(--radius-lg)] p-6">
					{view === "loading" && (
						<p className="text-sm text-text-tertiary text-center py-4">Loading request…</p>
					)}

					{view === "login" && (
						<form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
							<p className="text-sm text-text-tertiary">Sign in to continue.</p>
							<div>
								<label
									htmlFor="email"
									className="block text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-1.5"
								>
									Email
								</label>
								<input
									id="email"
									type="email"
									autoComplete="username"
									{...register("email")}
									className={inputClass}
									placeholder="you@example.com"
								/>
								{errors.email && (
									<p role="alert" className="text-xs text-danger mt-1.5">
										{errors.email.message}
									</p>
								)}
							</div>

							<div>
								<label
									htmlFor="password"
									className="block text-[11px] font-mono uppercase tracking-wider text-text-tertiary mb-1.5"
								>
									Password
								</label>
								<input
									id="password"
									type="password"
									autoComplete="current-password"
									{...register("password")}
									className={inputClass}
									placeholder="••••••••"
								/>
								{errors.password && (
									<p role="alert" className="text-xs text-danger mt-1.5">
										{errors.password.message}
									</p>
								)}
							</div>

							{authError && (
								<p role="alert" className={errorClass}>
									{authError}
								</p>
							)}

							<button
								type="submit"
								disabled={isSubmitting || !authorizationId}
								className="w-full bg-amber-glow text-text-inverse font-medium text-sm rounded-[var(--radius-sm)] py-2.5 hover:bg-amber-bright transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
							>
								{isSubmitting ? "Signing in…" : "Sign in"}
							</button>
						</form>
					)}

					{view === "consent" && (
						<div className="space-y-4">
							{details && (
								<>
									<p className="text-sm text-text-primary">
										<span className="font-medium">{details.clientName}</span> wants to connect.
									</p>
									{details.scopes.length > 0 && (
										<ul className="space-y-1">
											{details.scopes.map((scope) => (
												<li
													key={scope}
													className="text-xs font-mono text-text-tertiary bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] px-2.5 py-1.5"
												>
													{scope}
												</li>
											))}
										</ul>
									)}
								</>
							)}

							{consentError && (
								<p role="alert" className={errorClass}>
									{consentError}
								</p>
							)}

							{details && (
								<div className="space-y-2">
									<button
										type="button"
										onClick={() => decide(true)}
										disabled={deciding}
										className="w-full bg-amber-glow text-text-inverse font-medium text-sm rounded-[var(--radius-sm)] py-2.5 hover:bg-amber-bright transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
									>
										Allow
									</button>
									<button
										type="button"
										onClick={() => decide(false)}
										disabled={deciding}
										className="w-full bg-surface-2 text-text-primary border border-border-subtle font-medium text-sm rounded-[var(--radius-sm)] py-2.5 hover:border-border-active transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
									>
										Deny
									</button>
								</div>
							)}
						</div>
					)}

					{view === "done" && (
						<p className="text-sm text-text-tertiary text-center py-4">Redirecting you back…</p>
					)}
				</div>
			</motion.div>
		</div>
	);
}

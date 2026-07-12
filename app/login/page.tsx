"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { createBrowserSupabase } from "@/lib/supabase-browser";

const loginSchema = z.object({
	email: z.string().email("Enter a valid email"),
	password: z.string().min(1, "Password is required"),
});

type LoginForm = z.infer<typeof loginSchema>;

export default function LoginPage() {
	const router = useRouter();
	const [authError, setAuthError] = useState<string | null>(null);
	const {
		register,
		handleSubmit,
		formState: { errors, isSubmitting },
	} = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

	const onSubmit = async ({ email, password }: LoginForm) => {
		setAuthError(null);
		const supabase = createBrowserSupabase();
		const { error } = await supabase.auth.signInWithPassword({ email, password });
		if (error) {
			setAuthError(error.message);
			return;
		}
		router.push("/");
		// Re-read cookie state server-side so pages don't render a stale
		// logged-out RSC payload.
		router.refresh();
	};

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
					<p className="text-sm text-text-tertiary mt-1">One owner. Sign in to continue.</p>
				</div>

				<form
					onSubmit={handleSubmit(onSubmit)}
					className="bg-surface-1 border border-border-subtle rounded-[var(--radius-lg)] p-6 space-y-4"
				>
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
							autoComplete="email"
							{...register("email")}
							className="w-full bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-active transition-colors"
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
							className="w-full bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-active transition-colors"
							placeholder="••••••••"
						/>
						{errors.password && (
							<p role="alert" className="text-xs text-danger mt-1.5">
								{errors.password.message}
							</p>
						)}
					</div>

					{authError && (
						<p
							role="alert"
							className="text-xs text-danger bg-danger/10 border border-danger/25 rounded-[var(--radius-sm)] px-3 py-2"
						>
							{authError}
						</p>
					)}

					<button
						type="submit"
						disabled={isSubmitting}
						className="w-full bg-amber-glow text-text-inverse font-medium text-sm rounded-[var(--radius-sm)] py-2.5 hover:bg-amber-bright transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
					>
						{isSubmitting ? "Signing in…" : "Sign in"}
					</button>
				</form>
			</motion.div>
		</div>
	);
}

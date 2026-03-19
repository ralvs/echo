"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";

type CapturedThought = {
	id: string;
	metadata: Record<string, unknown>;
	category: string | null;
	due_at: string | null;
	priority: number | null;
};

export default function CapturePage() {
	const router = useRouter();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [content, setContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<CapturedThought | null>(null);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	// Auto-resize textarea
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.max(160, el.scrollHeight)}px`;
	}, [content]);

	const handleCapture = async () => {
		if (!content.trim() || saving) return;
		setSaving(true);
		setResult(null);

		try {
			const res = await fetch("/api/thoughts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content }),
			});
			const data = await res.json();

			if (res.ok) {
				setResult(data);
				setTimeout(() => {
					setContent("");
					setResult(null);
					textareaRef.current?.focus();
				}, 3000);
			}
		} finally {
			setSaving(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && e.metaKey) {
			e.preventDefault();
			handleCapture();
		}
	};

	const metadata = result?.metadata as Record<string, unknown> | undefined;
	const type = metadata?.type as string | undefined;
	const topics = metadata?.topics as string[] | undefined;
	const people = metadata?.people as string[] | undefined;
	const actionItems = metadata?.action_items as string[] | undefined;

	return (
		<div className="p-8 max-w-[700px]">
			<motion.div
				initial={{ opacity: 0, y: -8 }}
				animate={{ opacity: 1, y: 0 }}
				className="mb-8"
			>
				<h1 className="font-display text-4xl text-text-primary mb-1">
					Capture
				</h1>
				<p className="text-text-secondary text-sm">
					Just write. Echo handles the rest.
				</p>
			</motion.div>

			<motion.div
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 0.05 }}
				className="space-y-4"
			>
				<div className="relative">
					<textarea
						ref={textareaRef}
						id="thought-content"
						aria-label="Your thought"
						value={content}
						onChange={(e) => setContent(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Decisions, observations, tasks, notes about people, reminders with dates — just write naturally..."
						disabled={saving}
						className="w-full min-h-[160px] bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] p-5 text-[15px] text-text-primary placeholder:text-text-tertiary focus:border-border-active focus:outline-none transition-colors resize-none font-body leading-relaxed disabled:opacity-50"
					/>

					{/* Processing indicator */}
					<AnimatePresence>
						{saving && (
							<motion.div
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								className="absolute inset-0 rounded-[var(--radius-md)] pointer-events-none overflow-hidden"
							>
								<div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
									<motion.div
										className="h-full w-1/3 bg-gradient-to-r from-transparent via-amber-glow to-transparent"
										animate={{ x: ["-100%", "400%"] }}
										transition={{
											repeat: Infinity,
											duration: 1.5,
											ease: "linear",
										}}
									/>
								</div>
							</motion.div>
						)}
					</AnimatePresence>
				</div>

				{/* Actions */}
				<div className="flex items-center justify-between">
					<button
						type="button"
						onClick={handleCapture}
						disabled={!content.trim() || saving}
						className="px-6 py-2.5 rounded-[var(--radius-sm)] bg-amber-glow text-text-inverse text-sm font-medium hover:bg-amber-bright transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						{saving ? "Processing..." : "Capture"}
					</button>

					<span className="text-[11px] text-text-tertiary font-mono">
						{saving ? "extracting metadata & embedding…" : "⌘ Enter"}
					</span>
				</div>

				{/* Result feedback */}
				<AnimatePresence>
					{result && (
						<motion.div
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -4 }}
							className="bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] p-4 space-y-3"
						>
							<div className="flex items-center gap-2">
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="text-success"
								>
									<path d="M20 6L9 17l-5-5" />
								</svg>
								<span className="text-sm text-text-primary font-medium">
									Captured
								</span>
								{type && (
									<span className={`type-tag type-${type}`}>{type.replace(/_/g, " ")}</span>
								)}
							</div>

							{/* Extracted metadata summary */}
							<div className="flex flex-wrap gap-1.5">
								{result.category && (
									<span className="px-2 py-0.5 text-[11px] font-mono rounded-full bg-surface-3 text-text-secondary border border-border-subtle">
										{result.category}
									</span>
								)}
								{topics?.map((t) => (
									<span
										key={t}
										className="px-2 py-0.5 text-[11px] font-mono rounded-full bg-amber-faint text-amber-dim"
									>
										{t}
									</span>
								))}
								{people?.map((p) => (
									<span
										key={p}
										className="px-2 py-0.5 text-[11px] font-mono rounded-full bg-surface-3 text-text-secondary"
									>
										@{p}
									</span>
								))}
								{result.due_at && (
									<span className="px-2 py-0.5 text-[11px] font-mono rounded-full bg-amber-glow/10 text-amber-bright">
										due {new Date(result.due_at).toLocaleDateString()}
									</span>
								)}
								{result.priority !== null && result.priority > 0 && (
									<span className="px-2 py-0.5 text-[11px] font-mono rounded-full bg-danger/15 text-danger">
										{["", "low", "medium", "high", "urgent"][result.priority]}
									</span>
								)}
							</div>

							{/* Action items */}
							{actionItems && actionItems.length > 0 && (
								<div className="text-[12px] text-text-secondary space-y-0.5">
									{actionItems.map((item, i) => (
										<div key={i} className="flex items-start gap-1.5">
											<span className="text-text-tertiary mt-px">→</span>
											<span>{item}</span>
										</div>
									))}
								</div>
							)}
						</motion.div>
					)}
				</AnimatePresence>
			</motion.div>
		</div>
	);
}

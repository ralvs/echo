"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";

const TYPES = ["observation", "task", "idea", "reference", "person_note"];

export default function CapturePage() {
	const router = useRouter();
	const [content, setContent] = useState("");
	const [type, setType] = useState<string | undefined>();
	const [topics, setTopics] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	const handleCapture = async () => {
		if (!content.trim()) return;
		setSaving(true);

		const metadata: Record<string, unknown> = { source: "echo" };
		if (type) metadata.type = type;
		if (topics.trim()) {
			metadata.topics = topics
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
		}

		await fetch("/api/thoughts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content, metadata }),
		});

		setSaving(false);
		setSaved(true);
		setTimeout(() => {
			setContent("");
			setType(undefined);
			setTopics("");
			setSaved(false);
		}, 1500);
	};

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
					Write a thought. It gets embedded and tagged automatically.
				</p>
			</motion.div>

			<motion.div
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 0.05 }}
				className="space-y-5"
			>
				{/* Content */}
				<div>
					<label
						htmlFor="thought-content"
						className="block text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2"
					>
						Thought
					</label>
					<textarea
						id="thought-content"
						value={content}
						onChange={(e) => setContent(e.target.value)}
						rows={6}
						placeholder="What's on your mind? Decisions, observations, ideas, notes about people..."
						className="w-full bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] p-4 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-active focus:outline-none transition-colors resize-y font-body leading-relaxed"
					/>
				</div>

				{/* Type override */}
				<div>
					<label className="block text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2">
						Type{" "}
						<span className="text-text-tertiary/60 normal-case">
							(optional — auto-detected if blank)
						</span>
					</label>
					<div className="flex flex-wrap gap-1.5">
						{TYPES.map((t) => (
							<button
								key={t}
								type="button"
								onClick={() => setType(type === t ? undefined : t)}
								className={`px-3 py-1.5 rounded-full text-xs capitalize transition-colors ${
									type === t
										? "bg-amber-glow/15 text-amber-bright border border-border-active"
										: "bg-surface-3 text-text-secondary border border-transparent hover:border-border-subtle"
								}`}
							>
								{t.replace(/_/g, " ")}
							</button>
						))}
					</div>
				</div>

				{/* Topics */}
				<div>
					<label
						htmlFor="topics"
						className="block text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2"
					>
						Topics{" "}
						<span className="text-text-tertiary/60 normal-case">
							(optional — comma-separated)
						</span>
					</label>
					<input
						id="topics"
						type="text"
						value={topics}
						onChange={(e) => setTopics(e.target.value)}
						placeholder="e.g. career, project-x, q2-planning"
						className="w-full bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] px-4 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-active focus:outline-none transition-colors"
					/>
				</div>

				{/* Submit */}
				<div className="flex items-center gap-3 pt-2">
					<button
						type="button"
						onClick={handleCapture}
						disabled={!content.trim() || saving}
						className="px-6 py-2.5 rounded-[var(--radius-sm)] bg-amber-glow text-text-inverse text-sm font-medium hover:bg-amber-bright transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						{saving ? "Capturing..." : "Capture thought"}
					</button>

					<AnimatePresence>
						{saved && (
							<motion.span
								initial={{ opacity: 0, x: -8 }}
								animate={{ opacity: 1, x: 0 }}
								exit={{ opacity: 0 }}
								className="text-sm text-success flex items-center gap-1.5"
							>
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M20 6L9 17l-5-5" />
								</svg>
								Saved
							</motion.span>
						)}
					</AnimatePresence>
				</div>

				{/* Hint */}
				<p className="text-[11px] text-text-tertiary leading-relaxed pt-2">
					Thoughts captured here don't generate embeddings automatically —
					they're stored as-is. For full embedding + metadata extraction,
					capture via your AI client (Claude, ChatGPT) using the MCP server.
				</p>
			</motion.div>
		</div>
	);
}

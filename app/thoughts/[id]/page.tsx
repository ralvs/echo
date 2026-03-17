"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { DateTime } from "luxon";
import { TypeTag } from "@/components/type-tag";
import { TopicPill } from "@/components/topic-pill";
import type { Thought, ThoughtVersion } from "@/lib/types";

export default function ThoughtDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = use(params);
	const router = useRouter();
	const [thought, setThought] = useState<Thought | null>(null);
	const [versions, setVersions] = useState<ThoughtVersion[]>([]);
	const [isEditing, setIsEditing] = useState(false);
	const [editContent, setEditContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [showVersions, setShowVersions] = useState(false);

	useEffect(() => {
		fetch(`/api/thoughts/${id}`)
			.then((r) => r.json())
			.then(setThought);
	}, [id]);

	const loadVersions = async () => {
		const data = await fetch(`/api/thoughts/${id}/versions`).then((r) =>
			r.json(),
		);
		setVersions(data);
		setShowVersions(true);
	};

	const handleSave = async () => {
		if (!editContent.trim() || editContent === thought?.content) {
			setIsEditing(false);
			return;
		}
		setSaving(true);
		const updated = await fetch(`/api/thoughts/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: editContent }),
		}).then((r) => r.json());
		setThought(updated);
		setIsEditing(false);
		setSaving(false);
	};

	const handleDelete = async () => {
		await fetch(`/api/thoughts/${id}`, { method: "DELETE" });
		router.push("/thoughts");
	};

	if (!thought) {
		return (
			<div className="flex items-center justify-center h-screen">
				<div className="w-6 h-6 rounded-full border-2 border-amber-glow/30 border-t-amber-glow animate-spin" />
			</div>
		);
	}

	return (
		<div className="p-8 max-w-[800px]">
			{/* Back nav */}
			<motion.div
				initial={{ opacity: 0, x: -8 }}
				animate={{ opacity: 1, x: 0 }}
				className="mb-6"
			>
				<button
					type="button"
					onClick={() => router.back()}
					className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary text-sm transition-colors"
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M19 12H5" />
						<path d="M12 19l-7-7 7-7" />
					</svg>
					Back
				</button>
			</motion.div>

			{/* Header */}
			<motion.div
				initial={{ opacity: 0, y: -8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 0.05 }}
				className="flex items-start justify-between mb-6"
			>
				<div>
					<div className="flex items-center gap-3 mb-2">
						{thought.metadata?.type && (
							<TypeTag type={thought.metadata.type} />
						)}
						{thought.version > 1 && (
							<span className="text-[10px] font-mono text-text-tertiary bg-surface-3 px-2 py-0.5 rounded">
								v{thought.version}
							</span>
						)}
					</div>
					<p className="text-xs font-mono text-text-tertiary">
						{DateTime.fromISO(thought.created_at).toFormat(
							"EEEE, LLL d yyyy · h:mm a",
						)}
						{thought.updated_at !== thought.created_at && (
							<>
								{" "}
								· edited{" "}
								{DateTime.fromISO(thought.updated_at).toRelative()}
							</>
						)}
					</p>
				</div>
				<div className="flex items-center gap-2">
					{thought.version > 1 && (
						<button
							type="button"
							onClick={loadVersions}
							className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-surface-3 border border-border-subtle text-xs text-text-secondary hover:text-text-primary hover:border-border-default transition-colors"
						>
							History
						</button>
					)}
					<button
						type="button"
						onClick={() => {
							setEditContent(thought.content);
							setIsEditing(true);
						}}
						className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-surface-3 border border-border-subtle text-xs text-text-secondary hover:text-text-primary hover:border-border-default transition-colors"
					>
						Edit
					</button>
					<button
						type="button"
						onClick={() => setShowDeleteConfirm(true)}
						className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-surface-3 border border-border-subtle text-xs text-danger hover:bg-danger/10 hover:border-danger/30 transition-colors"
					>
						Delete
					</button>
				</div>
			</motion.div>

			{/* Content */}
			<motion.div
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 0.1 }}
				className="bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] p-6 mb-6"
			>
				{isEditing ? (
					<div>
						<textarea
							value={editContent}
							onChange={(e) => setEditContent(e.target.value)}
							rows={8}
							aria-label="Edit thought content"
							className="w-full bg-surface-1 border border-border-default rounded-[var(--radius-sm)] p-4 text-sm text-text-primary resize-y focus:border-border-active focus:outline-none transition-colors font-body"
						/>
						<div className="flex justify-end gap-2 mt-3">
							<button
								type="button"
								onClick={() => setIsEditing(false)}
								className="px-4 py-2 rounded-[var(--radius-sm)] text-xs text-text-secondary hover:text-text-primary transition-colors"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleSave}
								disabled={saving}
								className="px-4 py-2 rounded-[var(--radius-sm)] bg-amber-glow text-text-inverse text-xs font-medium hover:bg-amber-bright transition-colors disabled:opacity-50"
							>
								{saving ? "Saving..." : "Save changes"}
							</button>
						</div>
					</div>
				) : (
					<p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
						{thought.content}
					</p>
				)}
			</motion.div>

			{/* Metadata */}
			<motion.div
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 0.15 }}
				className="grid grid-cols-2 gap-4 mb-6"
			>
				{thought.metadata?.topics?.length ? (
					<div className="bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] p-4">
						<h3 className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2.5">
							Topics
						</h3>
						<div className="flex flex-wrap gap-1.5">
							{thought.metadata.topics.map((t) => (
								<TopicPill key={t} topic={t} />
							))}
						</div>
					</div>
				) : null}
				{thought.metadata?.people?.length ? (
					<div className="bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] p-4">
						<h3 className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2.5">
							People
						</h3>
						<div className="flex flex-wrap gap-1.5">
							{thought.metadata.people.map((p) => (
								<span
									key={p}
									className="text-sm text-text-primary"
								>
									{p}
								</span>
							))}
						</div>
					</div>
				) : null}
				{thought.metadata?.action_items?.length ? (
					<div className="col-span-2 bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] p-4">
						<h3 className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mb-2.5">
							Action Items
						</h3>
						<ul className="space-y-1.5">
							{thought.metadata.action_items.map((item) => (
								<li
									key={item}
									className="flex items-start gap-2 text-sm text-text-secondary"
								>
									<span className="text-amber-dim mt-0.5">
										&bull;
									</span>
									{item}
								</li>
							))}
						</ul>
					</div>
				) : null}
			</motion.div>

			{/* ID for reference */}
			<div className="text-[10px] font-mono text-text-tertiary">
				ID: {thought.id}
			</div>

			{/* Version history panel */}
			<AnimatePresence>
				{showVersions && (
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-8"
						onClick={() => setShowVersions(false)}
					>
						<motion.div
							initial={{ opacity: 0, scale: 0.95, y: 12 }}
							animate={{ opacity: 1, scale: 1, y: 0 }}
							exit={{ opacity: 0, scale: 0.95, y: 12 }}
							onClick={(e) => e.stopPropagation()}
							className="bg-surface-1 border border-border-subtle rounded-[var(--radius-lg)] p-6 max-w-[600px] w-full max-h-[80vh] overflow-y-auto"
						>
							<div className="flex items-center justify-between mb-5">
								<h2 className="font-display text-xl text-text-primary">
									Version History
								</h2>
								<button
									type="button"
									onClick={() => setShowVersions(false)}
									className="text-text-tertiary hover:text-text-primary transition-colors"
									aria-label="Close version history"
								>
									<svg
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
									>
										<path d="M18 6L6 18M6 6l12 12" />
									</svg>
								</button>
							</div>

							{/* Current version */}
							<div className="mb-4 p-4 bg-surface-2 border border-border-active rounded-[var(--radius-sm)]">
								<div className="flex items-center justify-between mb-2">
									<span className="text-xs font-mono text-amber-glow">
										v{thought.version} (current)
									</span>
									<span className="text-[10px] font-mono text-text-tertiary">
										{DateTime.fromISO(
											thought.updated_at,
										).toRelative()}
									</span>
								</div>
								<p className="text-sm text-text-primary line-clamp-3">
									{thought.content}
								</p>
							</div>

							{/* Historical versions */}
							<div className="space-y-2">
								{versions.map((v) => (
									<div
										key={v.id}
										className="p-4 bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)]"
									>
										<div className="flex items-center justify-between mb-2">
											<span className="text-xs font-mono text-text-secondary">
												v{v.version}
											</span>
											<span className="text-[10px] font-mono text-text-tertiary">
												archived{" "}
												{DateTime.fromISO(
													v.archived_at,
												).toRelative()}
											</span>
										</div>
										<p className="text-sm text-text-secondary line-clamp-3">
											{v.content}
										</p>
									</div>
								))}
								{versions.length === 0 && (
									<p className="text-xs text-text-tertiary text-center py-4">
										No previous versions
									</p>
								)}
							</div>
						</motion.div>
					</motion.div>
				)}
			</AnimatePresence>

			{/* Delete confirmation */}
			<AnimatePresence>
				{showDeleteConfirm && (
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-8"
						onClick={() => setShowDeleteConfirm(false)}
					>
						<motion.div
							initial={{ opacity: 0, scale: 0.95 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0, scale: 0.95 }}
							onClick={(e) => e.stopPropagation()}
							className="bg-surface-1 border border-border-subtle rounded-[var(--radius-lg)] p-6 max-w-[400px] w-full"
						>
							<h2 className="font-display text-xl text-text-primary mb-2">
								Delete thought?
							</h2>
							<p className="text-sm text-text-secondary mb-5">
								This will permanently delete this thought and all
								its version history. This cannot be undone.
							</p>
							<div className="flex justify-end gap-2">
								<button
									type="button"
									onClick={() => setShowDeleteConfirm(false)}
									className="px-4 py-2 rounded-[var(--radius-sm)] text-xs text-text-secondary hover:text-text-primary transition-colors"
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={handleDelete}
									className="px-4 py-2 rounded-[var(--radius-sm)] bg-danger text-white text-xs font-medium hover:bg-danger/80 transition-colors"
								>
									Delete permanently
								</button>
							</div>
						</motion.div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

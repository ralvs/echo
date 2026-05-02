"use client";

import { DateTime } from "luxon";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect } from "react";
import { TypeTag } from "@/components/type-tag";
import { useSearch } from "@/lib/hooks/use-search";
import { useThoughtList } from "@/lib/hooks/use-thought-list";

const TYPES = ["observation", "task", "idea", "reference", "person_note"];
const TIME_RANGES = [
	{ label: "All time", value: undefined },
	{ label: "7 days", value: 7 },
	{ label: "30 days", value: 30 },
	{ label: "90 days", value: 90 },
];

export default function ThoughtsPage() {
	const { thoughts, isLoading, filters, setFilters, refresh } = useThoughtList();
	const { query, setQuery, results: searchResults, isSearching, search } = useSearch();

	useEffect(() => {
		if (!query) refresh();
	}, [refresh, query]);

	const displayThoughts = query ? searchResults : thoughts;

	return (
		<div className="p-8 max-w-[1000px]">
			<motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
				<h1 className="font-display text-4xl text-text-primary mb-1">Thoughts</h1>
				<p className="text-text-secondary text-sm">{thoughts.length} captured</p>
			</motion.div>

			{/* Search */}
			<motion.div
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ delay: 0.05 }}
				className="mb-6"
			>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						search();
					}}
					className="relative"
				>
					<input
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search by meaning..."
						aria-label="Semantic search"
						className="w-full bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] px-4 py-3 pl-10 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-active focus:outline-none transition-colors"
					/>
					<svg
						className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-tertiary"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="11" cy="11" r="8" />
						<line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					{isSearching && (
						<div className="absolute right-3.5 top-1/2 -translate-y-1/2">
							<div className="w-4 h-4 rounded-full border-2 border-amber-glow/30 border-t-amber-glow animate-spin" />
						</div>
					)}
				</form>
			</motion.div>

			{/* Filters */}
			{!query && (
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ delay: 0.1 }}
					className="flex items-center gap-3 mb-6 flex-wrap"
				>
					<div className="flex items-center gap-1.5">
						<span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mr-1">
							Status
						</span>
						{[
							{ label: "All", value: undefined },
							{ label: "Open", value: "open" },
							{ label: "Resolved", value: "resolved" },
						].map((s) => (
							<button
								key={s.label}
								type="button"
								onClick={() => setFilters({ ...filters, status: s.value })}
								className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
									filters.status === s.value
										? "bg-amber-glow/15 text-amber-bright border border-border-active"
										: "bg-surface-3 text-text-secondary border border-transparent hover:border-border-subtle"
								}`}
							>
								{s.label}
							</button>
						))}
					</div>

					<div className="w-px h-5 bg-border-subtle" />

					<div className="flex items-center gap-1.5">
						<span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mr-1">
							Type
						</span>
						<button
							type="button"
							onClick={() => setFilters({ ...filters, type: undefined })}
							className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
								!filters.type
									? "bg-amber-glow/15 text-amber-bright border border-border-active"
									: "bg-surface-3 text-text-secondary border border-transparent hover:border-border-subtle"
							}`}
						>
							All
						</button>
						{TYPES.map((t) => (
							<button
								key={t}
								type="button"
								onClick={() =>
									setFilters({
										...filters,
										type: filters.type === t ? undefined : t,
									})
								}
								className={`px-2.5 py-1 rounded-full text-xs capitalize transition-colors ${
									filters.type === t
										? "bg-amber-glow/15 text-amber-bright border border-border-active"
										: "bg-surface-3 text-text-secondary border border-transparent hover:border-border-subtle"
								}`}
							>
								{t.replace(/_/g, " ")}
							</button>
						))}
					</div>

					<div className="w-px h-5 bg-border-subtle" />

					<div className="flex items-center gap-1.5">
						<span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mr-1">
							Time
						</span>
						{TIME_RANGES.map((range) => (
							<button
								key={range.label}
								type="button"
								onClick={() => setFilters({ ...filters, days: range.value })}
								className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
									filters.days === range.value
										? "bg-amber-glow/15 text-amber-bright border border-border-active"
										: "bg-surface-3 text-text-secondary border border-transparent hover:border-border-subtle"
								}`}
							>
								{range.label}
							</button>
						))}
					</div>
				</motion.div>
			)}

			{/* List */}
			{isLoading ? (
				<div className="flex justify-center py-20">
					<div className="w-6 h-6 rounded-full border-2 border-amber-glow/30 border-t-amber-glow animate-spin" />
				</div>
			) : (
				<div className="space-y-2">
					<AnimatePresence mode="popLayout">
						{displayThoughts.map((thought, i) => (
							<motion.div
								key={thought.id}
								layout
								initial={{ opacity: 0, y: 8 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, scale: 0.96 }}
								transition={{ duration: 0.3, delay: Math.min(i * 0.02, 0.3) }}
							>
								<Link
									href={`/thoughts/${thought.id}`}
									className="block bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] p-4 hover:border-border-default transition-all group"
								>
									<div className="flex items-start justify-between gap-4 mb-2">
										<p
											className={`text-sm line-clamp-2 transition-colors flex-1 ${
												thought.metadata?.status === "resolved"
													? "text-text-tertiary line-through decoration-text-tertiary/40"
													: "text-text-primary group-hover:text-amber-bright"
											}`}
										>
											{thought.content}
										</p>
										<div className="flex items-center gap-2 shrink-0">
											{"similarity" in thought && (
												<span className="text-[10px] font-mono text-amber-dim">
													{((thought.similarity as number) * 100).toFixed(0)}%
												</span>
											)}
											{thought.version > 1 && (
												<span className="text-[10px] font-mono text-text-tertiary bg-surface-3 px-1.5 py-0.5 rounded">
													v{thought.version}
												</span>
											)}
											<span className="text-[10px] font-mono text-text-tertiary whitespace-nowrap">
												{DateTime.fromISO(thought.created_at).toRelative()}
											</span>
										</div>
									</div>
									<div className="flex items-center gap-2 flex-wrap">
										{thought.metadata?.type && <TypeTag type={thought.metadata.type} />}
										{thought.metadata?.status && (
											<span
												className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
													thought.metadata.status === "resolved"
														? "text-success/70 bg-success/8"
														: "text-warning/70 bg-warning/8"
												}`}
											>
												{thought.metadata.status}
											</span>
										)}
										{thought.priority != null && thought.priority > 0 && (
											<span
												className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
													thought.priority >= 4
														? "text-danger bg-danger/10"
														: thought.priority >= 3
															? "text-warning bg-warning/10"
															: "text-text-tertiary bg-surface-3"
												}`}
											>
												{["", "low", "med", "high", "urgent"][thought.priority]}
											</span>
										)}
										{thought.due_at && (
											<span
												className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
													new Date(thought.due_at) < new Date() &&
													thought.metadata?.status !== "resolved"
														? "text-danger bg-danger/10"
														: "text-text-secondary bg-surface-3"
												}`}
											>
												{new Date(thought.due_at) < new Date() &&
												thought.metadata?.status !== "resolved"
													? "overdue"
													: `due ${DateTime.fromISO(thought.due_at).toRelative()}`}
											</span>
										)}
										{thought.recurrence && (
											<span className="text-[10px] font-mono text-text-tertiary" title="Recurring">
												↻
											</span>
										)}
										{thought.category && (
											<span className="text-[10px] font-mono text-text-tertiary bg-surface-3 px-1.5 py-0.5 rounded-full">
												{thought.category}
											</span>
										)}
										{thought.metadata?.topics?.slice(0, 4).map((t) => (
											<span key={t} className="text-[10px] font-mono text-text-tertiary">
												#{t}
											</span>
										))}
										{thought.metadata?.people?.length ? (
											<span className="text-[10px] text-text-tertiary ml-auto">
												{thought.metadata.people
													.map((p: unknown) =>
														typeof p === "string" ? p : (p as Record<string, unknown>)?.name || "",
													)
													.join(", ")}
											</span>
										) : null}
									</div>
								</Link>
							</motion.div>
						))}
					</AnimatePresence>
					{displayThoughts.length === 0 && (
						<div className="text-center py-20">
							<p className="text-text-tertiary text-sm">
								{query ? "No matching thoughts found." : "No thoughts captured yet."}
							</p>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

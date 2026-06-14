"use client";

import { DateTime } from "luxon";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import type { GraphData } from "@/app/api/graph/route";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { StatCard } from "@/components/stat-card";
import { TopicPill } from "@/components/topic-pill";
import type { Thought, ThoughtStats } from "@/lib/types";

const RECENT_THOUGHTS_LIMIT = 5;
const MAX_DASHBOARD_ENTRIES = 12;

function sortEntries(obj: Record<string, number>) {
	return Object.entries(obj)
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_DASHBOARD_ENTRIES);
}

export default function DashboardPage() {
	const [stats, setStats] = useState<ThoughtStats | null>(null);
	const [recent, setRecent] = useState<Thought[]>([]);
	const [graph, setGraph] = useState<GraphData>({ nodes: [], links: [] });
	const [graphMode, setGraphMode] = useState<"thoughts" | "entities">("thoughts");
	const [loading, setLoading] = useState(true);

	const loadGraph = (mode: "thoughts" | "entities") => {
		setGraphMode(mode);
		fetch(mode === "entities" ? "/api/graph?mode=entity" : "/api/graph")
			.then((r) => r.json())
			.catch(() => ({ nodes: [], links: [] }))
			.then(setGraph);
	};

	useEffect(() => {
		Promise.all([
			fetch("/api/stats")
				.then((r) => r.json())
				.catch(() => ({ total: 0, dateRange: null, types: {}, topics: {}, people: {} })),
			fetch(`/api/thoughts?limit=${RECENT_THOUGHTS_LIMIT}`)
				.then((r) => r.json())
				.catch(() => []),
			fetch("/api/graph")
				.then((r) => r.json())
				.catch(() => ({ nodes: [], links: [] })),
		]).then(([statsData, recentData, graphData]) => {
			setStats(statsData);
			setRecent(Array.isArray(recentData) ? recentData : []);
			setGraph(graphData);
			setLoading(false);
		});
	}, []);

	if (loading) {
		return (
			<div className="flex items-center justify-center h-screen">
				<div className="w-6 h-6 rounded-full border-2 border-amber-glow/30 border-t-amber-glow animate-spin" />
			</div>
		);
	}

	const dateRange = stats?.dateRange
		? `${DateTime.fromISO(stats.dateRange.from).toFormat("LLL d")} — ${DateTime.fromISO(stats.dateRange.to).toFormat("LLL d, yyyy")}`
		: "No data yet";

	return (
		<div className="p-8 max-w-[1200px]">
			<motion.div
				initial={{ opacity: 0, y: -8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.6 }}
				className="mb-10"
			>
				<h1 className="font-display text-4xl text-text-primary mb-1">Your Brain</h1>
				<p className="text-text-secondary text-sm">{dateRange}</p>
			</motion.div>

			{/* Stat cards */}
			<div className="grid grid-cols-4 gap-4 mb-10">
				<StatCard label="Total Thoughts" value={stats?.total || 0} delay={0.05} />
				<StatCard
					label="Types"
					value={Object.keys(stats?.types || {}).length}
					subtitle="distinct categories"
					delay={0.1}
				/>
				<StatCard
					label="Topics"
					value={Object.keys(stats?.topics || {}).length}
					subtitle="unique tags"
					delay={0.15}
				/>
				<StatCard
					label="People"
					value={Object.keys(stats?.people || {}).length}
					subtitle="mentioned"
					delay={0.2}
				/>
			</div>

			<div className="grid grid-cols-3 gap-6">
				{/* Type breakdown */}
				<motion.div
					initial={{ opacity: 0, y: 12 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5, delay: 0.25 }}
					className="bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] p-5"
				>
					<h2 className="text-[11px] font-mono text-text-tertiary tracking-wider uppercase mb-4">
						By Type
					</h2>
					<div className="space-y-3">
						{sortEntries(stats?.types || {}).map(([type, count]) => {
							const pct = stats?.total ? (count / stats.total) * 100 : 0;
							return (
								<a
									key={type}
									href={`/thoughts?type=${encodeURIComponent(type)}`}
									className="block group"
								>
									<div className="flex justify-between items-center mb-1.5">
										<span className="text-sm text-text-primary capitalize group-hover:text-amber-bright transition-colors">
											{type.replace(/_/g, " ")}
										</span>
										<span className="text-xs font-mono text-text-tertiary group-hover:text-amber-glow transition-colors">
											{count}
										</span>
									</div>
									<div className="h-1 bg-surface-3 rounded-full overflow-hidden">
										<motion.div
											initial={{ width: 0 }}
											animate={{ width: `${pct}%` }}
											transition={{ duration: 0.8, delay: 0.4 }}
											className="h-full bg-amber-glow/60 group-hover:bg-amber-glow rounded-full transition-colors"
										/>
									</div>
								</a>
							);
						})}
					</div>
				</motion.div>

				{/* Top topics */}
				<motion.div
					initial={{ opacity: 0, y: 12 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5, delay: 0.3 }}
					className="bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] p-5"
				>
					<h2 className="text-[11px] font-mono text-text-tertiary tracking-wider uppercase mb-4">
						Top Topics
					</h2>
					<div className="flex flex-wrap gap-2">
						{sortEntries(stats?.topics || {}).map(([topic, count]) => (
							<TopicPill
								key={topic}
								topic={topic}
								count={count}
								href={`/thoughts?topic=${encodeURIComponent(topic)}`}
							/>
						))}
					</div>
				</motion.div>

				{/* People */}
				<motion.div
					initial={{ opacity: 0, y: 12 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5, delay: 0.35 }}
					className="bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] p-5"
				>
					<h2 className="text-[11px] font-mono text-text-tertiary tracking-wider uppercase mb-4">
						People
					</h2>
					<div className="space-y-2.5">
						{sortEntries(stats?.people || {}).map(([person, count]) => (
							<a
								key={person}
								href={`/thoughts?person=${encodeURIComponent(person)}`}
								className="flex justify-between items-center group"
							>
								<span className="text-sm text-text-primary group-hover:text-amber-bright transition-colors">
									{person}
								</span>
								<span className="text-xs font-mono text-text-tertiary group-hover:text-amber-glow transition-colors">
									{count} mention{count !== 1 ? "s" : ""}
								</span>
							</a>
						))}
						{Object.keys(stats?.people || {}).length === 0 && (
							<p className="text-xs text-text-tertiary italic">No people mentioned yet</p>
						)}
					</div>
				</motion.div>
			</div>

			{/* Recent thoughts */}
			<motion.div
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.5, delay: 0.4 }}
				className="mt-8"
			>
				<h2 className="text-[11px] font-mono text-text-tertiary tracking-wider uppercase mb-4">
					Recent
				</h2>
				<div className="space-y-2">
					{recent.map((thought) => (
						<a
							key={thought.id}
							href={`/thoughts/${thought.id}`}
							className="block bg-surface-2 border border-border-subtle rounded-[var(--radius-sm)] p-4 hover:border-border-default transition-colors group"
						>
							<div className="flex items-start justify-between gap-4">
								<p className="text-sm text-text-primary line-clamp-2 group-hover:text-amber-bright transition-colors">
									{thought.content}
								</p>
								<span className="text-[10px] font-mono text-text-tertiary whitespace-nowrap mt-0.5">
									{DateTime.fromISO(thought.created_at).toRelative()}
								</span>
							</div>
							<div className="flex items-center gap-2 mt-2">
								{thought.metadata?.type && (
									<span className={`type-tag type-${thought.metadata.type}`}>
										{thought.metadata.type.replace(/_/g, " ")}
									</span>
								)}
								{thought.metadata?.topics?.slice(0, 3).map((t) => (
									<span key={t} className="text-[10px] font-mono text-text-tertiary">
										#{t}
									</span>
								))}
							</div>
						</a>
					))}
				</div>
			</motion.div>

			{/* Knowledge graph */}
			<motion.div
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.5, delay: 0.5 }}
				className="mt-8 bg-surface-2 border border-border-subtle rounded-[var(--radius-md)] overflow-hidden"
			>
				<div className="px-5 pt-5 pb-4 flex items-center justify-between gap-3">
					<h2 className="text-[11px] font-mono text-text-tertiary tracking-wider uppercase">
						Knowledge Graph
					</h2>
					<div className="flex items-center gap-1 rounded-[var(--radius-sm)] bg-surface-3 p-0.5">
						{(["thoughts", "entities"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								onClick={() => loadGraph(mode)}
								aria-pressed={graphMode === mode}
								className={`px-2.5 py-1 rounded-[var(--radius-sm)] text-[10px] font-mono tracking-wide capitalize transition-colors ${
									graphMode === mode
										? "bg-surface-1 text-text-primary"
										: "text-text-tertiary hover:text-text-secondary"
								}`}
							>
								{mode}
							</button>
						))}
					</div>
				</div>
				<KnowledgeGraph
					nodes={graph.nodes}
					links={graph.links}
					onNodeClick={graphMode === "entities" ? () => {} : undefined}
				/>
			</motion.div>
		</div>
	);
}

"use client";

import { useMemo, useState } from "react";
import type { GraphLink, GraphNode } from "@/app/api/graph/route";
import { communityColor, DEFAULT_NODE_COLOR, TYPE_COLORS } from "@/lib/graph-colors";

export type GraphGroup = {
	key: string | number;
	label: string;
	color: string;
	count: number;
};

type Props = {
	nodes: GraphNode[];
	links: GraphLink[];
	mode: "thoughts" | "entities";
	groups: GraphGroup[];
	hiddenGroups: Set<string | number>;
	onToggleGroup: (key: string | number) => void;
	selectedNode: GraphNode | null;
	onSelectNode: (node: GraphNode) => void;
};

function endpointId(endpoint: GraphLink["source"]): string {
	// force-graph mutates link endpoints from id strings into node objects.
	return typeof endpoint === "string" ? endpoint : (endpoint as GraphNode).id;
}

function nodeColor(node: GraphNode): string {
	return node.community !== undefined
		? communityColor(node.community)
		: (TYPE_COLORS[node.type ?? ""] ?? DEFAULT_NODE_COLOR);
}

export function GraphSidebar({
	nodes,
	links,
	mode,
	groups,
	hiddenGroups,
	onToggleGroup,
	selectedNode,
	onSelectNode,
}: Props) {
	const [query, setQuery] = useState("");

	const results = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		return nodes.filter((n) => n.label.toLowerCase().includes(q)).slice(0, 20);
	}, [query, nodes]);

	const degreeMap = useMemo(() => {
		const map = new Map<string, number>();
		for (const link of links) {
			const src = endpointId(link.source);
			const tgt = endpointId(link.target);
			map.set(src, (map.get(src) ?? 0) + 1);
			map.set(tgt, (map.get(tgt) ?? 0) + 1);
		}
		return map;
	}, [links]);

	const neighbors = useMemo(() => {
		if (!selectedNode) return [];
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const seen = new Set<string>();
		const out: GraphNode[] = [];
		for (const link of links) {
			const src = endpointId(link.source);
			const tgt = endpointId(link.target);
			const otherId = src === selectedNode.id ? tgt : tgt === selectedNode.id ? src : null;
			if (!otherId || seen.has(otherId)) continue;
			seen.add(otherId);
			const other = byId.get(otherId);
			if (other) out.push(other);
		}
		return out.sort((a, b) => (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0));
	}, [selectedNode, nodes, links, degreeMap]);

	const communityCount = useMemo(
		() => new Set(nodes.map((n) => n.community).filter((c) => c !== undefined)).size,
		[nodes],
	);

	return (
		<div
			className="hidden md:flex w-[280px] flex-shrink-0 flex-col border-l border-border-subtle"
			style={{ backgroundColor: "#13121f" }}
		>
			{/* Search */}
			<div className="p-3 border-b border-border-subtle">
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search nodes…"
					aria-label="Search graph nodes"
					className="w-full rounded-[var(--radius-sm)] bg-[#0f0f1a] border border-border-subtle px-2.5 py-1.5 text-xs text-[#e0e0e0] placeholder:text-text-tertiary font-mono focus:outline-none focus:border-[#4E79A7]"
				/>
				{results.length > 0 && (
					<ul className="mt-2 max-h-40 overflow-y-auto space-y-0.5">
						{results.map((node) => (
							<li key={node.id}>
								<button
									type="button"
									onClick={() => onSelectNode(node)}
									className="w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[11px] font-mono text-text-secondary hover:text-[#e0e0e0] hover:bg-white/5 transition-colors"
								>
									<span
										aria-hidden
										className="w-1.5 h-1.5 rounded-full flex-shrink-0"
										style={{ backgroundColor: nodeColor(node) }}
									/>
									<span className="truncate">{node.label}</span>
								</button>
							</li>
						))}
					</ul>
				)}
				{query.trim() && results.length === 0 && (
					<p className="mt-2 px-2 text-[10px] font-mono text-text-tertiary">No matches.</p>
				)}
			</div>

			{/* Node info */}
			{selectedNode && (
				<div className="p-3 border-b border-border-subtle">
					<p className="text-xs text-[#e0e0e0] leading-snug break-words">{selectedNode.label}</p>
					<div className="mt-2 flex items-center gap-2 text-[10px] font-mono text-text-tertiary">
						<span className="flex items-center gap-1.5">
							<span
								aria-hidden
								className="w-1.5 h-1.5 rounded-full"
								style={{ backgroundColor: nodeColor(selectedNode) }}
							/>
							{selectedNode.community !== undefined
								? `cluster ${selectedNode.community + 1}`
								: (selectedNode.type?.replace(/_/g, " ") ?? "unknown")}
						</span>
						<span>·</span>
						<span>{degreeMap.get(selectedNode.id) ?? 0} connections</span>
					</div>
					{mode === "thoughts" && (
						<a
							href={`/thoughts/${selectedNode.id}`}
							className="mt-2 inline-block text-[11px] font-mono text-[#4E79A7] hover:underline"
						>
							Open thought →
						</a>
					)}
					{neighbors.length > 0 && (
						<div className="mt-3">
							<p className="text-[9px] font-mono text-text-tertiary tracking-wider uppercase mb-1.5">
								Neighbors
							</p>
							<ul className="max-h-36 overflow-y-auto space-y-0.5">
								{neighbors.map((node) => (
									<li key={node.id}>
										<button
											type="button"
											onClick={() => onSelectNode(node)}
											className="w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[11px] font-mono text-text-secondary hover:text-[#e0e0e0] hover:bg-white/5 transition-colors"
										>
											<span
												aria-hidden
												className="w-1.5 h-1.5 rounded-full flex-shrink-0"
												style={{ backgroundColor: nodeColor(node) }}
											/>
											<span className="truncate">{node.label}</span>
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}

			{/* Legend toggles */}
			<div className="p-3 flex-1 overflow-y-auto">
				<p className="text-[9px] font-mono text-text-tertiary tracking-wider uppercase mb-1.5">
					{mode === "entities" ? "Clusters" : "Types"}
				</p>
				<ul className="space-y-0.5">
					{groups.map((group) => {
						const hidden = hiddenGroups.has(group.key);
						return (
							<li key={String(group.key)}>
								<button
									type="button"
									onClick={() => onToggleGroup(group.key)}
									aria-pressed={!hidden}
									className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[11px] font-mono transition-colors hover:bg-white/5 ${
										hidden ? "text-text-tertiary line-through opacity-50" : "text-text-secondary"
									}`}
								>
									<span
										aria-hidden
										className="w-2 h-2 rounded-full flex-shrink-0"
										style={{ backgroundColor: group.color }}
									/>
									<span className="truncate flex-1">{group.label}</span>
									<span className="text-text-tertiary">{group.count}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>

			{/* Stats footer */}
			<div className="px-3 py-2 border-t border-border-subtle text-[9px] font-mono text-text-tertiary">
				{nodes.length} nodes · {links.length} edges
				{mode === "entities" && communityCount > 0 && (
					<>
						{" "}
						· {communityCount} cluster{communityCount === 1 ? "" : "s"}
					</>
				)}
			</div>
		</div>
	);
}

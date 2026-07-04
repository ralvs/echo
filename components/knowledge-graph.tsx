"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphData, GraphLink, GraphNode } from "@/app/api/graph/route";
import { type GraphGroup, GraphSidebar } from "@/components/graph-sidebar";
import { communityColor, DEFAULT_NODE_COLOR, TYPE_COLORS } from "@/lib/graph-colors";

const KnowledgeGraphCanvas = dynamic(
	() =>
		import("@/components/knowledge-graph-canvas").then((m) => ({
			default: m.KnowledgeGraphCanvas,
		})),
	{
		ssr: false,
		loading: () => (
			<div
				className="animate-pulse rounded-[var(--radius-sm)] bg-surface-3"
				style={{ height: 480 }}
			/>
		),
	},
);

type Props = {
	nodes: GraphNode[];
	links: GraphLink[];
	height?: number;
	centerNodeId?: string;
};

function endpointId(endpoint: GraphLink["source"]): string {
	// force-graph mutates link endpoints from id strings into node objects.
	return typeof endpoint === "string" ? endpoint : (endpoint as GraphNode).id;
}

function groupKey(node: GraphNode): string | number {
	return node.community !== undefined ? node.community : (node.type ?? "unknown");
}

export function KnowledgeGraph({ nodes, links, height = 480, centerNodeId }: Props) {
	const canvasBoxRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState<number | undefined>(undefined);
	const [hiddenGroups, setHiddenGroups] = useState<Set<string | number>>(new Set());
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [focusRequest, setFocusRequest] = useState<{ id: string; token: number } | undefined>();

	const mode: "thoughts" | "entities" = nodes.some((n) => n.community !== undefined)
		? "entities"
		: "thoughts";

	useEffect(() => {
		const el = canvasBoxRef.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => {
			setWidth(entry.contentRect.width);
		});
		observer.observe(el);
		setWidth(el.clientWidth);
		return () => observer.disconnect();
	}, []);

	// Switching between thought/entity datasets invalidates selection & toggles.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the dataset itself
	useEffect(() => {
		setHiddenGroups(new Set());
		setSelectedNodeId(null);
		setFocusRequest(undefined);
	}, [nodes]);

	const groups = useMemo<GraphGroup[]>(() => {
		const counts = new Map<string | number, number>();
		for (const node of nodes) {
			const key = groupKey(node);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([key, count]) => ({
				key,
				count,
				label: typeof key === "number" ? `Cluster ${key + 1}` : key.replace(/_/g, " "),
				color:
					typeof key === "number" ? communityColor(key) : (TYPE_COLORS[key] ?? DEFAULT_NODE_COLOR),
			}));
	}, [nodes]);

	const visibleNodes = useMemo(
		() => nodes.filter((n) => !hiddenGroups.has(groupKey(n))),
		[nodes, hiddenGroups],
	);

	const visibleLinks = useMemo(() => {
		if (hiddenGroups.size === 0) return links;
		const visible = new Set(visibleNodes.map((n) => n.id));
		return links.filter(
			(l) => visible.has(endpointId(l.source)) && visible.has(endpointId(l.target)),
		);
	}, [links, visibleNodes, hiddenGroups]);

	const selectedNode = useMemo(
		() => visibleNodes.find((n) => n.id === selectedNodeId) ?? null,
		[visibleNodes, selectedNodeId],
	);

	const handleToggleGroup = (key: string | number) => {
		setHiddenGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	const handleSelectNode = (node: GraphNode) => {
		setSelectedNodeId(node.id);
		setFocusRequest((prev) => ({ id: node.id, token: (prev?.token ?? 0) + 1 }));
	};

	const handleCanvasClick = (node: GraphNode) => {
		setSelectedNodeId(node.id);
	};

	const isolated = nodes.length > 0 && links.length === 0;

	if (nodes.length === 0) {
		return (
			<div
				className="flex items-center justify-center text-text-tertiary text-xs font-mono"
				style={{ height }}
			>
				No thoughts captured yet.
			</div>
		);
	}

	return (
		<div className="flex overflow-hidden rounded-[var(--radius-sm)]" style={{ height }}>
			<div ref={canvasBoxRef} className="relative flex-1 min-w-0">
				{!!width && (
					<KnowledgeGraphCanvas
						nodes={visibleNodes}
						links={visibleLinks}
						onNodeClick={handleCanvasClick}
						height={height}
						width={width}
						centerNodeId={centerNodeId}
						selectedNodeId={selectedNodeId ?? undefined}
						focusRequest={focusRequest}
					/>
				)}

				{isolated && (
					<div className="absolute inset-0 flex items-end justify-center pb-12 pointer-events-none">
						<p className="text-[10px] font-mono text-text-tertiary/60 text-center">
							Connections form automatically as you capture more thoughts.
						</p>
					</div>
				)}
			</div>

			<GraphSidebar
				nodes={nodes}
				links={links}
				mode={mode}
				groups={groups}
				hiddenGroups={hiddenGroups}
				onToggleGroup={handleToggleGroup}
				selectedNode={selectedNode}
				onSelectNode={handleSelectNode}
			/>
		</div>
	);
}

export type { GraphData, GraphLink, GraphNode };

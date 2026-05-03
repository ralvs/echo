"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { GraphData, GraphLink, GraphNode } from "@/app/api/graph/route";
import { TYPE_COLORS } from "@/components/knowledge-graph-canvas";

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
	onNodeClick?: (node: GraphNode) => void;
};

export function KnowledgeGraph({ nodes, links, height = 480, centerNodeId, onNodeClick }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState<number | undefined>(undefined);
	const router = useRouter();

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => {
			setWidth(entry.contentRect.width);
		});
		observer.observe(el);
		setWidth(el.clientWidth);
		return () => observer.disconnect();
	}, []);

	const handleNodeClick = (node: GraphNode) => {
		if (onNodeClick) {
			onNodeClick(node);
		} else {
			router.push(`/thoughts/${node.id}`);
		}
	};

	const presentTypes = [...new Set(nodes.map((n) => n.type).filter(Boolean))] as string[];
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
		<div ref={containerRef} className="relative overflow-hidden rounded-[var(--radius-sm)]">
			{width && (
				<KnowledgeGraphCanvas
					nodes={nodes}
					links={links}
					onNodeClick={handleNodeClick}
					height={height}
					width={width}
					centerNodeId={centerNodeId}
				/>
			)}

			{isolated && (
				<div className="absolute inset-0 flex items-end justify-center pb-12 pointer-events-none">
					<p className="text-[10px] font-mono text-text-tertiary/60 text-center">
						Connections form automatically as you capture more thoughts.
					</p>
				</div>
			)}

			{/* Type legend */}
			{presentTypes.length > 0 && (
				<div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5 pointer-events-none">
					{presentTypes.map((type) => (
						<div
							key={type}
							className="flex items-center gap-1.5 bg-surface-0/85 backdrop-blur-sm px-2 py-[3px] rounded text-[9px] font-mono text-text-tertiary tracking-wide"
						>
							<span
								className="w-1.5 h-1.5 rounded-full flex-shrink-0"
								style={{ backgroundColor: TYPE_COLORS[type] ?? "#6b665c" }}
							/>
							{type.replace(/_/g, " ")}
						</div>
					))}
				</div>
			)}

			{/* Stats badge */}
			<div className="absolute bottom-3 right-3 text-[9px] font-mono text-text-tertiary bg-surface-0/85 backdrop-blur-sm px-2 py-[3px] rounded pointer-events-none">
				{nodes.length} nodes · {links.length} edges
			</div>
		</div>
	);
}

export type { GraphData, GraphLink, GraphNode };

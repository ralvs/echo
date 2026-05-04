"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { GraphLink, GraphNode } from "@/app/api/graph/route";
import { DEFAULT_NODE_COLOR as DEFAULT_COLOR, LINK_COLORS, TYPE_COLORS } from "@/lib/graph-colors";

type InternalNode = GraphNode & {
	x?: number;
	y?: number;
	__degree: number;
};

type InternalLink = {
	source: string | InternalNode;
	target: string | InternalNode;
	relationType: string;
	confidence: number;
};

type Props = {
	nodes: GraphNode[];
	links: GraphLink[];
	onNodeClick?: (node: GraphNode) => void;
	height: number;
	width: number;
	centerNodeId?: string;
};

export function KnowledgeGraphCanvas({
	nodes,
	links,
	onNodeClick,
	height,
	width,
	centerNodeId,
}: Props) {
	// biome-ignore lint/suspicious/noExplicitAny: force-graph ref type is complex
	const graphRef = useRef<any>(null);

	const degreeMap = useMemo(() => {
		const map = new Map<string, number>();
		for (const link of links) {
			const src = typeof link.source === "string" ? link.source : (link.source as InternalNode).id;
			const tgt = typeof link.target === "string" ? link.target : (link.target as InternalNode).id;
			map.set(src, (map.get(src) ?? 0) + 1);
			map.set(tgt, (map.get(tgt) ?? 0) + 1);
		}
		return map;
	}, [links]);

	const enrichedNodes = useMemo(
		() => nodes.map((n) => ({ ...n, __degree: degreeMap.get(n.id) ?? 0 })),
		[nodes, degreeMap],
	);

	const nodeCanvasObject = useCallback(
		(rawNode: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
			const node = rawNode as InternalNode;
			const x = node.x ?? 0;
			const y = node.y ?? 0;
			const degree = node.__degree;
			const r = Math.max(5, Math.min(14, 5 + degree * 1.4));
			const color = TYPE_COLORS[node.type ?? ""] ?? DEFAULT_COLOR;
			const isCenter = node.id === centerNodeId;

			if (isCenter) {
				ctx.beginPath();
				ctx.arc(x, y, r + 11, 0, 2 * Math.PI);
				ctx.fillStyle = `${color}0d`;
				ctx.fill();
				ctx.beginPath();
				ctx.arc(x, y, r + 6, 0, 2 * Math.PI);
				ctx.fillStyle = `${color}22`;
				ctx.fill();
			}

			// Outer glow
			ctx.beginPath();
			ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
			ctx.fillStyle = `${color}1a`;
			ctx.fill();

			// Core
			ctx.beginPath();
			ctx.arc(x, y, r, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();

			// Inner specular
			ctx.beginPath();
			ctx.arc(x - r * 0.28, y - r * 0.28, r * 0.38, 0, 2 * Math.PI);
			ctx.fillStyle = "rgba(255,255,255,0.10)";
			ctx.fill();

			// Label — always visible, length scales with zoom
			{
				const maxLen = globalScale > 2 ? 38 : globalScale > 1.2 ? 24 : 16;
				const label = node.label.length > maxLen ? `${node.label.slice(0, maxLen)}…` : node.label;
				const targetPx = 9;
				const fontSize = Math.max(targetPx / globalScale, 3.5);
				ctx.font = `${fontSize}px "Overpass Mono", monospace`;
				const tw = ctx.measureText(label).width;
				const pad = 2.5 / globalScale;
				const bx = x - tw / 2 - pad;
				const by = y + r + 4 / globalScale;
				const bh = fontSize + pad * 2;
				ctx.fillStyle = "rgba(12,11,10,0.80)";
				ctx.fillRect(bx, by, tw + pad * 2, bh);
				ctx.fillStyle = "rgba(232,228,222,0.80)";
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				ctx.fillText(label, x, by + pad);
				ctx.textBaseline = "alphabetic";
			}
		},
		[centerNodeId],
	);

	const nodePointerAreaPaint = useCallback(
		(rawNode: object, color: string, ctx: CanvasRenderingContext2D) => {
			const node = rawNode as InternalNode;
			const x = node.x ?? 0;
			const y = node.y ?? 0;
			const r = Math.max(5, Math.min(14, 5 + node.__degree * 1.4)) + 4;
			ctx.beginPath();
			ctx.arc(x, y, r, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();
		},
		[],
	);

	const getLinkColor = useCallback(
		(link: object) => LINK_COLORS[(link as InternalLink).relationType] ?? "rgba(154,149,137,0.15)",
		[],
	);

	const getLinkWidth = useCallback(
		(link: object) => Math.max(0.3, (link as InternalLink).confidence * 1.2),
		[],
	);

	const getLinkArrowColor = useCallback(
		(link: object) => LINK_COLORS[(link as InternalLink).relationType] ?? "rgba(154,149,137,0.15)",
		[],
	);

	const nodeLabel = useCallback((rawNode: object) => {
		const node = rawNode as InternalNode;
		return node.label;
	}, []);

	const handleNodeClick = useCallback(
		(rawNode: object) => {
			onNodeClick?.(rawNode as GraphNode);
		},
		[onNodeClick],
	);

	useEffect(() => {
		if (!centerNodeId || !graphRef.current) return;
		const t = setTimeout(() => {
			const n = enrichedNodes.find((node) => node.id === centerNodeId) as InternalNode | undefined;
			if (n?.x !== undefined && n.y !== undefined) {
				graphRef.current.centerAt(n.x, n.y, 600);
				graphRef.current.zoom(3.5, 600);
			}
		}, 2200);
		return () => clearTimeout(t);
	}, [centerNodeId, enrichedNodes]);

	return (
		<ForceGraph2D
			ref={graphRef}
			graphData={{ nodes: enrichedNodes, links }}
			nodeCanvasObject={nodeCanvasObject}
			nodeCanvasObjectMode={() => "replace"}
			nodePointerAreaPaint={nodePointerAreaPaint}
			nodeLabel={nodeLabel}
			onNodeClick={handleNodeClick}
			linkColor={getLinkColor}
			linkWidth={getLinkWidth}
			linkDirectionalArrowLength={3.5}
			linkDirectionalArrowRelPos={1}
			linkDirectionalArrowColor={getLinkArrowColor}
			backgroundColor="#141311"
			width={width}
			height={height}
			d3AlphaDecay={0.018}
			d3VelocityDecay={0.28}
			warmupTicks={80}
			cooldownTime={4000}
		/>
	);
}

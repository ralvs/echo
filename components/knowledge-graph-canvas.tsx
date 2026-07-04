"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { GraphLink, GraphNode } from "@/app/api/graph/route";
import {
	communityColor,
	DEFAULT_NODE_COLOR as DEFAULT_COLOR,
	DEFAULT_LINK_COLOR,
	LINK_COLORS,
	TYPE_COLORS,
} from "@/lib/graph-colors";

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

// Graphify-style sqrt-degree sizing (15 + sqrt(degree) * 5 capped at 45 in
// vis.js pixels), scaled down to force-graph coordinate units.
function nodeRadius(degree: number): number {
	return Math.min(15, 5 + Math.sqrt(degree) * 1.8);
}

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

	const maxDegree = useMemo(
		() => enrichedNodes.reduce((max, n) => Math.max(max, n.__degree), 0),
		[enrichedNodes],
	);

	const nodeCanvasObject = useCallback(
		(rawNode: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
			const node = rawNode as InternalNode;
			const x = node.x ?? 0;
			const y = node.y ?? 0;
			const degree = node.__degree;
			const r = nodeRadius(degree);
			// Entity-mode nodes carry a community index and colour by cluster;
			// thought-mode nodes colour by type.
			const color =
				node.community !== undefined
					? communityColor(node.community)
					: (TYPE_COLORS[node.type ?? ""] ?? DEFAULT_COLOR);
			const isCenter = node.id === centerNodeId;

			if (isCenter) {
				ctx.beginPath();
				ctx.arc(x, y, r + 9, 0, 2 * Math.PI);
				ctx.fillStyle = `${color}14`;
				ctx.fill();
				ctx.beginPath();
				ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
				ctx.fillStyle = `${color}26`;
				ctx.fill();
			}

			// Flat Graphify dot: solid core + subtle border
			ctx.beginPath();
			ctx.arc(x, y, r, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();
			ctx.strokeStyle = "rgba(224,224,224,0.35)";
			ctx.lineWidth = 1.5 / globalScale;
			ctx.stroke();

			// Labels are hub-only at rest (Graphify shows them for nodes at
			// >= 15% of max degree); everything gets a label once zoomed in.
			const isHub = maxDegree > 0 && degree >= 0.15 * maxDegree;
			if (isHub || globalScale > 2.5 || isCenter) {
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
				ctx.fillStyle = "rgba(15,15,26,0.85)";
				ctx.fillRect(bx, by, tw + pad * 2, bh);
				ctx.fillStyle = "rgba(224,224,224,0.85)";
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				ctx.fillText(label, x, by + pad);
				ctx.textBaseline = "alphabetic";
			}
		},
		[centerNodeId, maxDegree],
	);

	const nodePointerAreaPaint = useCallback(
		(rawNode: object, color: string, ctx: CanvasRenderingContext2D) => {
			const node = rawNode as InternalNode;
			const x = node.x ?? 0;
			const y = node.y ?? 0;
			const r = nodeRadius(node.__degree) + 4;
			ctx.beginPath();
			ctx.arc(x, y, r, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();
		},
		[],
	);

	const getLinkColor = useCallback(
		(link: object) => LINK_COLORS[(link as InternalLink).relationType] ?? DEFAULT_LINK_COLOR,
		[],
	);

	const getLinkWidth = useCallback(
		(link: object) => Math.max(0.3, (link as InternalLink).confidence * 1.2),
		[],
	);

	// Graphify draws INFERRED/low-confidence relationships dashed.
	const getLinkLineDash = useCallback(
		(link: object) => ((link as InternalLink).confidence < 0.6 ? [4, 3] : null),
		[],
	);

	const getLinkArrowColor = useCallback(
		(link: object) => LINK_COLORS[(link as InternalLink).relationType] ?? DEFAULT_LINK_COLOR,
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

	// Approximate Graphify's forceAtlas2Based physics (gravitationalConstant
	// -60, springLength 120) on top of d3-force.
	useEffect(() => {
		const graph = graphRef.current;
		if (!graph) return;
		graph.d3Force("charge")?.strength(-60);
		graph.d3Force("link")?.distance(120);
	}, []);

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
			linkCurvature={0.2}
			linkLineDash={getLinkLineDash}
			linkDirectionalArrowLength={3.5}
			linkDirectionalArrowRelPos={1}
			linkDirectionalArrowColor={getLinkArrowColor}
			backgroundColor="#0f0f1a"
			width={width}
			height={height}
			d3AlphaDecay={0.018}
			d3VelocityDecay={0.4}
			warmupTicks={80}
			cooldownTime={4000}
		/>
	);
}

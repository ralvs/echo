/**
 * Graph palette ported from Graphify's HTML export (Tableau-10). Node colours
 * come from this single palette in both modes so the canvas reads as one
 * visual system: thought types map onto fixed slots, communities cycle.
 */
export const TYPE_COLORS: Record<string, string> = {
	observation: "#4E79A7",
	task: "#F28E2B",
	idea: "#B07AA1",
	reference: "#59A14F",
	person_note: "#FF9DA7",
};

export const DEFAULT_NODE_COLOR = "#BAB0AC";

/**
 * Cluster palette for the entity graph's community colouring. Indices cycle, so
 * any number of communities renders; the order matches graph_overview's
 * lowest-member normalisation, keeping the two views visually consistent.
 */
export const COMMUNITY_COLORS = [
	"#4E79A7",
	"#F28E2B",
	"#E15759",
	"#76B7B2",
	"#59A14F",
	"#EDC948",
	"#B07AA1",
	"#FF9DA7",
	"#9C755F",
	"#BAB0AC",
];

export function communityColor(index: number | undefined): string {
	if (index === undefined) return DEFAULT_NODE_COLOR;
	return COMMUNITY_COLORS[index % COMMUNITY_COLORS.length];
}

export const LINK_COLORS: Record<string, string> = {
	updates: "#F28E2B",
	extends: "#9C755F",
	derives: "#4E79A7",
	related: "rgba(186, 176, 172, 0.22)",
};

/** Neutral edge colour for relation types outside LINK_COLORS (e.g. entity co-occurrence). */
export const DEFAULT_LINK_COLOR = "rgba(186, 176, 172, 0.28)";

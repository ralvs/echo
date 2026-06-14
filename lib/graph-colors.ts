export const TYPE_COLORS: Record<string, string> = {
	observation: "#7bb8d4",
	task: "#e8b86d",
	idea: "#c4a8e0",
	reference: "#82c496",
	person_note: "#d4a098",
};

export const DEFAULT_NODE_COLOR = "#6b665c";

/**
 * Cluster palette for the entity graph's community colouring. Indices cycle, so
 * any number of communities renders; the order matches graph_overview's
 * lowest-member normalisation, keeping the two views visually consistent.
 */
export const COMMUNITY_COLORS = [
	"#7bb8d4",
	"#e8b86d",
	"#c4a8e0",
	"#82c496",
	"#d4a098",
	"#d39bc4",
	"#9fb86d",
	"#6dc4c4",
	"#e0a86d",
	"#a8b0e0",
];

export function communityColor(index: number | undefined): string {
	if (index === undefined) return DEFAULT_NODE_COLOR;
	return COMMUNITY_COLORS[index % COMMUNITY_COLORS.length];
}

export const LINK_COLORS: Record<string, string> = {
	updates: "#e8b86d",
	extends: "#9a7339",
	derives: "#7bb8d4",
	related: "rgba(154, 149, 137, 0.22)",
};

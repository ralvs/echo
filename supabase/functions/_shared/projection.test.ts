import { describe, expect, it } from "vitest";
import type { ExtractedMetadata } from "./ai.ts";
import { projectThought } from "./projection.ts";

const EXTRACTED: ExtractedMetadata = {
	people: ["Sarah"],
	action_items: [],
	dates_mentioned: [],
	topics: ["plumbing"],
	type: "observation",
	memory_type: "episodic",
	location: null,
	cost: null,
	url: null,
	rating: null,
	relationship: null,
	project: null,
	organization: null,
	tools: [],
	sentiment: null,
	category: "home",
	due_at: null,
	recurrence: null,
	priority: 0,
	expires_at: null,
	event_at: null,
	person_definitions: [],
};

describe("projectThought", () => {
	it("builds metadata with the source tag and enriched embedding text", () => {
		const { metadata, columns, embeddingText } = projectThought(
			"Fixed the sink with Sarah",
			EXTRACTED,
			{},
			"mcp",
		);

		expect(metadata.source).toBe("mcp");
		expect(metadata.topics).toEqual(["plumbing"]);
		expect(columns.category).toBe("home");
		expect(embeddingText).toContain("Topics: plumbing");
		expect(embeddingText).toContain("People: Sarah");
	});

	it("lets caller overrides win over extracted values", () => {
		const { metadata, columns } = projectThought(
			"note",
			EXTRACTED,
			{ type: "task", topics: "errands, weekend", category: "household", priority: 3 },
			"echo",
		);

		expect(metadata.type).toBe("task");
		expect(metadata.topics).toEqual(["errands", "weekend"]);
		expect(metadata.status).toBe("open"); // tasks auto-open
		expect(columns.category).toBe("household");
		expect(columns.priority).toBe(3);
	});

	it("keeps a carried status instead of re-opening an actionable thought", () => {
		const { metadata } = projectThought(
			"revised task wording",
			{ ...EXTRACTED, type: "task" },
			{},
			"echo",
			{ carry: { status: "resolved", completion_count: 3 } },
		);

		expect(metadata.status).toBe("resolved");
		expect(metadata.completion_count).toBe(3);
	});

	it("falls back to extracted priority only when it carries signal", () => {
		expect(projectThought("x", { ...EXTRACTED, priority: 2 }, {}, "echo").columns.priority).toBe(2);
		expect(projectThought("x", { ...EXTRACTED, priority: 0 }, {}, "echo").columns.priority).toBe(
			null,
		);
	});

	it("applies a metadata patch last", () => {
		const { metadata } = projectThought("x", EXTRACTED, {}, "echo", {
			metadataPatch: { pinned: true, type: "idea" },
		});

		expect(metadata.pinned).toBe(true);
		expect(metadata.type).toBe("idea");
	});
});

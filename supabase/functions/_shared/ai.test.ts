import { describe, expect, it } from "vitest";
import { buildEmbeddingText, identifyTopicPage } from "./ai.ts";

describe("buildEmbeddingText", () => {
	it("returns just content when metadata is empty", () => {
		expect(buildEmbeddingText("hello", {}, null)).toBe("hello");
	});

	it("appends topics", () => {
		expect(buildEmbeddingText("note", { topics: ["cooking", "health"] }, null)).toBe(
			"note\n\nTopics: cooking, health",
		);
	});

	it("appends category", () => {
		expect(buildEmbeddingText("note", {}, "plumbing")).toBe("note\n\nCategory: plumbing");
	});

	it("omits type when it is the default 'observation'", () => {
		expect(buildEmbeddingText("note", { type: "observation" }, null)).toBe("note");
	});

	it("appends type when not 'observation'", () => {
		expect(buildEmbeddingText("note", { type: "task" }, null)).toBe("note\n\nType: task");
	});

	it("appends people", () => {
		expect(buildEmbeddingText("note", { people: ["Andrea", "Bella"] }, null)).toBe(
			"note\n\nPeople: Andrea, Bella",
		);
	});

	it("assembles all fields in order: topics → category → type → people", () => {
		const result = buildEmbeddingText(
			"note",
			{ topics: ["cooking"], type: "task", people: ["Andrea"] },
			"italian",
		);
		expect(result).toBe(
			"note\n\nTopics: cooking\n\nCategory: italian\n\nType: task\n\nPeople: Andrea",
		);
	});

	it("ignores empty topics array", () => {
		expect(buildEmbeddingText("note", { topics: [] }, null)).toBe("note");
	});

	it("ignores empty people array", () => {
		expect(buildEmbeddingText("note", { people: [] }, null)).toBe("note");
	});
});

describe("identifyTopicPage", () => {
	it("returns null for empty topics", () => {
		expect(identifyTopicPage([], [], [])).toBeNull();
	});

	it("matches an exact slug", () => {
		const pages = [{ slug: "cooking", title: "Cooking", embedding: [] }];
		expect(identifyTopicPage(["cooking"], pages, [])).toEqual({
			slug: "cooking",
			title: "Cooking",
			isNew: false,
		});
	});

	it("slugifies the topic before matching", () => {
		const pages = [{ slug: "home-repair", title: "Home Repair", embedding: [] }];
		expect(identifyTopicPage(["Home Repair"], pages, [])).toEqual({
			slug: "home-repair",
			title: "Home Repair",
			isNew: false,
		});
	});

	it("returns a new page candidate when no match", () => {
		expect(identifyTopicPage(["gardening"], [], [])).toEqual({
			slug: "gardening",
			title: "Gardening",
			isNew: true,
		});
	});

	it("title-cases multi-word slugs for new pages", () => {
		const result = identifyTopicPage(["home repair"], [], []);
		expect(result?.title).toBe("Home Repair");
		expect(result?.slug).toBe("home-repair");
	});

	it("matches by embedding cosine similarity above 0.85", () => {
		// Identical unit vectors → similarity = 1.0
		const embedding = [1, 0, 0];
		const pages = [{ slug: "fitness", title: "Fitness", embedding: [1, 0, 0] }];
		expect(identifyTopicPage(["exercise"], pages, embedding)).toEqual({
			slug: "fitness",
			title: "Fitness",
			isNew: false,
		});
	});

	it("does not match by similarity at or below 0.85", () => {
		// Orthogonal vectors → similarity = 0
		const embedding = [1, 0, 0];
		const pages = [{ slug: "fitness", title: "Fitness", embedding: [0, 1, 0] }];
		const result = identifyTopicPage(["exercise"], pages, embedding);
		expect(result).toEqual({ slug: "exercise", title: "Exercise", isNew: true });
	});

	it("prefers exact slug match over embedding similarity", () => {
		const embedding = [1, 0, 0];
		const pages = [
			{ slug: "exercise", title: "Exercise", embedding: [1, 0, 0] },
			{ slug: "fitness", title: "Fitness", embedding: [0.9, 0.1, 0] },
		];
		// "exercise" matches exactly — should win even though fitness has high similarity
		expect(identifyTopicPage(["exercise"], pages, embedding)).toEqual({
			slug: "exercise",
			title: "Exercise",
			isNew: false,
		});
	});
});

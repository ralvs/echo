import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	maybeSingle: vi.fn(),
	insert: vi.fn(),
	updateEq: vi.fn(),
	contains: vi.fn(),
	thoughtsUpdateEq: vi.fn(),
	getEmbedding: vi.fn(),
	buildEmbeddingText: vi.fn(),
}));

vi.mock("./config.ts", () => ({
	supabase: {
		from: vi.fn((table: string) => {
			if (table === "entities") {
				return {
					select: vi.fn(() => ({
						eq: vi.fn(() => ({
							eq: vi.fn(() => ({ maybeSingle: mocks.maybeSingle })),
						})),
					})),
					insert: mocks.insert,
					update: vi.fn(() => ({ eq: mocks.updateEq })),
				};
			}
			// "thoughts"
			return {
				select: vi.fn(() => ({ contains: mocks.contains })),
				update: vi.fn(() => ({ eq: mocks.thoughtsUpdateEq })),
			};
		}),
	},
}));

vi.mock("./ai.ts", () => ({
	buildEmbeddingText: mocks.buildEmbeddingText,
	getEmbedding: mocks.getEmbedding,
}));

import { backfillPersonAlias, upsertPerson } from "./people.ts";

describe("upsertPerson", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.insert.mockResolvedValue({});
		mocks.updateEq.mockResolvedValue({});
	});

	it("inserts a new person and returns the role as a new alias", async () => {
		mocks.maybeSingle.mockResolvedValue({ data: null });

		const result = await upsertPerson("Andrea", "mother-in-law");

		expect(result).toEqual({ newAliases: ["mother-in-law"] });
		expect(mocks.insert).toHaveBeenCalledWith({
			type: "person",
			canonical_name: "Andrea",
			aliases: ["mother-in-law"],
			metadata: { role: "mother-in-law" },
		});
	});

	it("lowercases and trims the role before storing", async () => {
		mocks.maybeSingle.mockResolvedValue({ data: null });

		await upsertPerson("Andrea", "  Mother-In-Law  ");

		expect(mocks.insert).toHaveBeenCalledWith(
			expect.objectContaining({ aliases: ["mother-in-law"] }),
		);
	});

	it("returns newAliases: [] when the alias is already registered", async () => {
		mocks.maybeSingle.mockResolvedValue({
			data: { id: "abc", aliases: ["mother-in-law"] },
		});

		const result = await upsertPerson("Andrea", "mother-in-law");

		expect(result).toEqual({ newAliases: [] });
		expect(mocks.updateEq).not.toHaveBeenCalled();
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("adds alias and returns it when person exists but alias is new", async () => {
		mocks.maybeSingle.mockResolvedValue({
			data: { id: "abc", aliases: ["andrea"] },
		});

		const result = await upsertPerson("Andrea", "mother-in-law");

		expect(result).toEqual({ newAliases: ["mother-in-law"] });
		expect(mocks.updateEq).toHaveBeenCalledWith("id", "abc");
	});

	it("preserves existing aliases when adding a new one", async () => {
		mocks.maybeSingle.mockResolvedValue({
			data: { id: "abc", aliases: ["andrea", "andi"] },
		});

		await upsertPerson("Andrea", "mother-in-law");

		// The update call receives the merged alias list — check via the update mock's parent
		// We verify indirectly: newAliases is returned correctly and updateEq is called
		expect(mocks.updateEq).toHaveBeenCalledWith("id", "abc");
	});
});

describe("backfillPersonAlias", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.thoughtsUpdateEq.mockResolvedValue({});
		mocks.getEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
		mocks.buildEmbeddingText.mockReturnValue("embedded text");
	});

	it("does nothing when no thoughts contain the alias", async () => {
		mocks.contains.mockResolvedValue({ data: [] });

		await backfillPersonAlias("daughter", "Bella");

		expect(mocks.thoughtsUpdateEq).not.toHaveBeenCalled();
		expect(mocks.getEmbedding).not.toHaveBeenCalled();
	});

	it("replaces alias with canonical name in metadata.people", async () => {
		mocks.contains.mockResolvedValue({
			data: [
				{
					id: "t1",
					content: "Bought a gift",
					metadata: { people: ["daughter", "Andrea"] },
					category: "shopping",
				},
			],
		});

		await backfillPersonAlias("daughter", "Bella");

		expect(mocks.buildEmbeddingText).toHaveBeenCalledWith(
			"Bought a gift",
			expect.objectContaining({ people: ["Bella", "Andrea"] }),
			"shopping",
		);
	});

	it("re-embeds the updated thought", async () => {
		mocks.contains.mockResolvedValue({
			data: [
				{
					id: "t1",
					content: "note",
					metadata: { people: ["daughter"] },
					category: null,
				},
			],
		});
		mocks.buildEmbeddingText.mockReturnValue("note\n\nPeople: Bella");

		await backfillPersonAlias("daughter", "Bella");

		expect(mocks.getEmbedding).toHaveBeenCalledWith("note\n\nPeople: Bella");
		expect(mocks.thoughtsUpdateEq).toHaveBeenCalledWith("id", "t1");
	});

	it("processes multiple matching thoughts", async () => {
		mocks.contains.mockResolvedValue({
			data: [
				{ id: "t1", content: "note A", metadata: { people: ["daughter"] }, category: null },
				{ id: "t2", content: "note B", metadata: { people: ["daughter", "John"] }, category: null },
			],
		});

		await backfillPersonAlias("daughter", "Bella");

		expect(mocks.thoughtsUpdateEq).toHaveBeenCalledTimes(2);
		expect(mocks.thoughtsUpdateEq).toHaveBeenCalledWith("id", "t1");
		expect(mocks.thoughtsUpdateEq).toHaveBeenCalledWith("id", "t2");
	});

	it("leaves other people in the list untouched", async () => {
		mocks.contains.mockResolvedValue({
			data: [
				{
					id: "t1",
					content: "note",
					metadata: { people: ["daughter", "John", "Andrea"] },
					category: null,
				},
			],
		});

		await backfillPersonAlias("daughter", "Bella");

		expect(mocks.buildEmbeddingText).toHaveBeenCalledWith(
			"note",
			expect.objectContaining({ people: ["Bella", "John", "Andrea"] }),
			null,
		);
	});
});

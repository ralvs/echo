import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ai } from "./model.ts";
import { backfillPersonAlias, upsertPerson } from "./people.ts";

const mocks = {
	maybeSingle: vi.fn(),
	insert: vi.fn(),
	updateEq: vi.fn(),
	contains: vi.fn(),
	thoughtsUpdateEq: vi.fn(),
	embed: vi.fn(),
};

const db = {
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
} as unknown as SupabaseClient;

const ai: Ai = {
	generate: vi.fn(),
	embed: mocks.embed,
};

describe("upsertPerson", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.insert.mockResolvedValue({});
		mocks.updateEq.mockResolvedValue({});
	});

	it("inserts a new person and returns the role as a new alias", async () => {
		mocks.maybeSingle.mockResolvedValue({ data: null });

		const result = await upsertPerson(db, "Andrea", "mother-in-law");

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

		await upsertPerson(db, "Andrea", "  Mother-In-Law  ");

		expect(mocks.insert).toHaveBeenCalledWith(
			expect.objectContaining({ aliases: ["mother-in-law"] }),
		);
	});

	it("returns newAliases: [] when the alias is already registered", async () => {
		mocks.maybeSingle.mockResolvedValue({
			data: { id: "abc", aliases: ["mother-in-law"] },
		});

		const result = await upsertPerson(db, "Andrea", "mother-in-law");

		expect(result).toEqual({ newAliases: [] });
		expect(mocks.updateEq).not.toHaveBeenCalled();
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("adds alias and returns it when person exists but alias is new", async () => {
		mocks.maybeSingle.mockResolvedValue({
			data: { id: "abc", aliases: ["andrea"] },
		});

		const result = await upsertPerson(db, "Andrea", "mother-in-law");

		expect(result).toEqual({ newAliases: ["mother-in-law"] });
		expect(mocks.updateEq).toHaveBeenCalledWith("id", "abc");
	});
});

describe("backfillPersonAlias", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.thoughtsUpdateEq.mockResolvedValue({});
		mocks.embed.mockResolvedValue([0.1, 0.2, 0.3]);
	});

	it("does nothing when no thoughts contain the alias", async () => {
		mocks.contains.mockResolvedValue({ data: [] });

		await backfillPersonAlias({ db, ai }, "daughter", "Bella");

		expect(mocks.thoughtsUpdateEq).not.toHaveBeenCalled();
		expect(mocks.embed).not.toHaveBeenCalled();
	});

	it("replaces the alias with the canonical name and re-embeds enriched text", async () => {
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

		await backfillPersonAlias({ db, ai }, "daughter", "Bella");

		// Re-embedded text is the enriched form with the canonical name swapped in
		expect(mocks.embed).toHaveBeenCalledWith(
			"Bought a gift\n\nCategory: shopping\n\nPeople: Bella, Andrea",
		);
		expect(mocks.thoughtsUpdateEq).toHaveBeenCalledWith("id", "t1");
	});

	it("processes multiple matching thoughts", async () => {
		mocks.contains.mockResolvedValue({
			data: [
				{ id: "t1", content: "note A", metadata: { people: ["daughter"] }, category: null },
				{ id: "t2", content: "note B", metadata: { people: ["daughter", "John"] }, category: null },
			],
		});

		await backfillPersonAlias({ db, ai }, "daughter", "Bella");

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

		await backfillPersonAlias({ db, ai }, "daughter", "Bella");

		expect(mocks.embed).toHaveBeenCalledWith("note\n\nPeople: Bella, John, Andrea");
	});
});

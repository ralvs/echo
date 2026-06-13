import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { UserProfile } from "./ai.ts";
import type { Ai } from "./model.ts";
import { formatUserProfile, synthesizeUserProfile } from "./profile.ts";

type Row = Record<string, unknown>;

const PROFILE: UserProfile = {
	static: {
		facts: ["Lives in Lisbon"],
		preferences: ["Prefers dark mode"],
		contact_graph: [{ name: "Sarah", role: "plumber" }],
		organizations: ["Acme"],
	},
	dynamic: {
		active_projects: ["Echo"],
		open_tasks: ["File taxes"],
	},
	summary: "A person.",
};

function fakeAi(profile: UserProfile = PROFILE) {
	const systems: string[] = [];
	const ai: Ai = {
		async generate(req): Promise<string> {
			systems.push(req.system);
			return JSON.stringify(profile);
		},
		async embed(): Promise<number[]> {
			return [];
		},
	};
	return { ai, systems };
}

/** Fake of the two corpus reads the profile workflow crosses. */
function createFakeDb(staticRows: Row[], dynamicRows: Row[]) {
	let call = 0;
	const db = {
		from: () => ({
			select: () => ({
				or: () => ({
					or: () => ({
						order: () => ({
							limit: async () => ({
								data: call++ === 0 ? staticRows : dynamicRows,
								error: null,
							}),
						}),
					}),
				}),
			}),
		}),
	};
	return db as unknown as SupabaseClient;
}

describe("synthesizeUserProfile", () => {
	it("returns empty without a model call when no thoughts exist", async () => {
		const db = createFakeDb([], []);
		const { ai, systems } = fakeAi();

		const result = await synthesizeUserProfile({ db, ai });

		expect(result.kind).toBe("empty");
		expect(systems).toHaveLength(0);
	});

	it("synthesizes and formats a profile from both corpora", async () => {
		const db = createFakeDb(
			[{ content: "Lives in Lisbon", metadata: { memory_type: "fact" } }],
			[{ content: "File taxes", metadata: { status: "open" }, due_at: null, priority: 2 }],
		);
		const { ai, systems } = fakeAi();

		const result = await synthesizeUserProfile({ db, ai }, "work");

		expect(result.kind).toBe("profile");
		if (result.kind !== "profile") return;
		expect(result.markdown).toContain("## Facts");
		expect(result.markdown).toContain("• Lives in Lisbon");
		// Both corpora reached the prompt; focus emphasized.
		expect(systems[0]).toContain("Lives in Lisbon");
		expect(systems[0]).toContain("File taxes");
		expect(systems[0]).toContain("Emphasize information related to: work");
	});
});

describe("formatUserProfile", () => {
	it("renders every populated section and skips empty ones", () => {
		const markdown = formatUserProfile(PROFILE);

		expect(markdown).toContain("## Summary");
		expect(markdown).toContain("## People\n• Sarah — plumber");
		expect(markdown).toContain("## Active Projects");
		expect(markdown).not.toContain("## Upcoming Events");
	});

	it("falls back to a placeholder for an empty profile", () => {
		expect(formatUserProfile({})).toBe("Profile is empty.");
	});
});

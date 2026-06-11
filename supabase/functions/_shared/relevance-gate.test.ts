import { describe, expect, it } from "vitest";
import type { Ai, ModelRequest } from "./model.ts";
import { estimateUsd, relevanceGate } from "./relevance-gate.ts";

const INPUT = { userMessage: "We'll use Biome, not ESLint", assistantMessage: "Noted." };

function fakeAi(response: string, usage?: { inputTokens: number; outputTokens: number }): Ai {
	const base: Ai = {
		generate: async () => response,
		embed: async () => [],
	};
	if (usage) {
		base.generateWithUsage = async () => ({ text: response, usage });
	}
	return base;
}

describe("relevanceGate", () => {
	it("parses a capture decision and reports usage from the adapter", async () => {
		const ai = fakeAi(
			JSON.stringify({
				should_capture: true,
				content: "I use Biome instead of ESLint",
				suggested_topics: ["tooling", "linting", "extra", "dropped"],
				suggested_type: "decision",
				memory_type: "preference",
				reason: "expressed preference",
			}),
			{ inputTokens: 100, outputTokens: 20 },
		);

		const { decision, usage } = await relevanceGate(ai, INPUT);

		expect(decision.should_capture).toBe(true);
		expect(decision.memory_type).toBe("preference");
		expect(decision.suggested_topics).toHaveLength(3); // capped at 3
		expect(usage).toEqual({ inputTokens: 100, outputTokens: 20 });
	});

	it("strips markdown fences and falls back to zero usage without generateWithUsage", async () => {
		const ai = fakeAi(
			`\`\`\`json\n${JSON.stringify({ should_capture: false, content: "", reason: "trivial" })}\n\`\`\``,
		);

		const { decision, usage } = await relevanceGate(ai, INPUT);

		expect(decision.should_capture).toBe(false);
		expect(decision.memory_type).toBe("episodic"); // default for invalid/missing
		expect(usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	it("treats capture-with-empty-content as a skip", async () => {
		const ai = fakeAi(JSON.stringify({ should_capture: true, content: "" }));

		const { decision } = await relevanceGate(ai, INPUT);

		expect(decision.should_capture).toBe(false);
		expect(decision.reason).toContain("empty content");
	});

	it("fails closed when the model call throws", async () => {
		const ai: Ai = {
			generate: async () => {
				throw new Error("gateway down");
			},
			embed: async () => [],
		};

		const { decision } = await relevanceGate(ai, INPUT);

		expect(decision.should_capture).toBe(false);
		expect(decision.reason).toContain("gateway down");
	});

	it("threads project and prior context into the prompt", async () => {
		let seen: ModelRequest | undefined;
		const ai: Ai = {
			generate: async (req) => {
				seen = req;
				return JSON.stringify({ should_capture: false });
			},
			embed: async () => [],
		};

		await relevanceGate(ai, { ...INPUT, projectName: "echo", priorContext: "earlier turn" });

		expect(seen?.prompt).toContain("Project: echo");
		expect(seen?.prompt).toContain("earlier turn");
	});
});

describe("estimateUsd", () => {
	it("prices at Haiku 4.5 rates", () => {
		expect(estimateUsd(1_000_000, 0)).toBe(1.0);
		expect(estimateUsd(0, 1_000_000)).toBe(5.0);
	});
});

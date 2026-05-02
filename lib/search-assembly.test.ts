import { describe, expect, it } from "vitest";
import { applyDecay } from "./search-assembly";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function makeResult(
	memoryType: string,
	ageMonths: number,
	similarity = 1.0,
) {
	return {
		id: crypto.randomUUID(),
		content: "test",
		similarity,
		created_at: new Date(Date.now() - ageMonths * MONTH_MS).toISOString(),
		metadata: { memory_type: memoryType },
	};
}

describe("applyDecay", () => {
	it("does not decay facts regardless of age", () => {
		const result = applyDecay([makeResult("fact", 24)]);
		expect(result[0].similarity).toBe(1.0);
	});

	it("does not decay procedural memory regardless of age", () => {
		const result = applyDecay([makeResult("procedural", 24)]);
		expect(result[0].similarity).toBe(1.0);
	});

	it("decays episodic memories over time", () => {
		const fresh = applyDecay([makeResult("episodic", 0)])[0];
		const old = applyDecay([makeResult("episodic", 12)])[0];
		expect(fresh.similarity).toBeGreaterThan(old.similarity);
	});

	it("clamps episodic decay floor at 0.5", () => {
		// 10 months * 0.05 = 0.5 decay → floor at 0.5
		const result = applyDecay([makeResult("episodic", 100)]);
		expect(result[0].similarity).toBe(0.5);
	});

	it("decays preference memories more slowly than episodic", () => {
		const episodic = applyDecay([makeResult("episodic", 6)])[0];
		const preference = applyDecay([makeResult("preference", 6)])[0];
		expect(preference.similarity).toBeGreaterThan(episodic.similarity);
	});

	it("clamps preference decay floor at 0.7", () => {
		const result = applyDecay([makeResult("preference", 100)]);
		expect(result[0].similarity).toBe(0.7);
	});

	it("sorts results by decayed similarity descending", () => {
		const results = applyDecay([
			makeResult("episodic", 12, 0.9),
			makeResult("fact", 0, 0.8),
			makeResult("episodic", 0, 0.95),
		]);
		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
		}
	});

	it("treats unknown memory_type as episodic", () => {
		const known = applyDecay([makeResult("episodic", 6)])[0];
		const unknown = applyDecay([makeResult("unknown_type", 6)])[0];
		expect(unknown.similarity).toBe(known.similarity);
	});

	it("returns empty array unchanged", () => {
		expect(applyDecay([])).toEqual([]);
	});
});

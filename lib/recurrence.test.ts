import { describe, expect, it } from "vitest";
import { advanceRecurrence } from "./recurrence";

const DAY = 24 * 60 * 60 * 1000;

function daysAhead(from: Date, n: number): Date {
	return new Date(from.getTime() + n * DAY);
}

describe("advanceRecurrence", () => {
	const now = new Date("2026-01-15T12:00:00Z");

	it("advances by interval_days when unit is unset", () => {
		const result = advanceRecurrence(now, { interval_days: 7 }, now);
		expect(result).toEqual(daysAhead(now, 7));
	});

	it("advances by 1 day when interval_days is omitted", () => {
		const result = advanceRecurrence(now, {}, now);
		expect(result).toEqual(daysAhead(now, 1));
	});

	it("advances monthly by interval count", () => {
		const result = advanceRecurrence(now, { unit: "month", interval_days: 1 }, now);
		expect(result.getUTCMonth()).toBe(1); // February
		expect(result.getUTCFullYear()).toBe(2026);
	});

	it("pins to day_of_month when advancing monthly", () => {
		const result = advanceRecurrence(now, { unit: "month", interval_days: 1, day_of_month: 5 }, now);
		expect(result.getDate()).toBe(5);
		expect(result.getMonth()).toBe(1); // February
	});

	it("skips forward to the next matching day_of_week (ISO: 1=Mon, 7=Sun)", () => {
		// now is 2026-01-15, a Thursday (ISO 4).
		// Rule: every 7 days, only on Monday (ISO 1).
		// Base after +7 days = 2026-01-22 (Thursday). Should skip to 2026-01-26 (Monday).
		const result = advanceRecurrence(now, { interval_days: 7, days_of_week: [1] }, now);
		expect(result.getDay()).toBe(1); // Monday in JS getDay()
	});

	it("returns a date strictly after now when currentDue is in the past", () => {
		const pastDue = new Date(now.getTime() - 10 * DAY);
		const result = advanceRecurrence(pastDue, { interval_days: 3 }, now);
		expect(result.getTime()).toBeGreaterThan(now.getTime());
	});

	it("handles null currentDue by treating it as now", () => {
		const result = advanceRecurrence(null, { interval_days: 5 }, now);
		expect(result).toEqual(daysAhead(now, 5));
	});
});

import type { RecurrenceRule } from "./types";

/**
 * Returns the next due date after resolving a recurring thought.
 * Pure function — no I/O. The resolve route applies the result to the DB.
 *
 * Invariant: result is always in the future relative to `now`.
 */
export function advanceRecurrence(currentDue: Date | null, rule: RecurrenceRule, now: Date): Date {
	const base = new Date(Math.max((currentDue ?? now).getTime(), now.getTime()));

	if (rule.unit === "month") {
		base.setMonth(base.getMonth() + (rule.interval_days ?? 1));
		if (rule.day_of_month) base.setDate(rule.day_of_month);
	} else {
		base.setDate(base.getDate() + (rule.interval_days ?? 1));
	}

	if (rule.days_of_week?.length) {
		const isoDay = (d: Date) => d.getDay() || 7;
		while (!rule.days_of_week.includes(isoDay(base))) {
			base.setDate(base.getDate() + 1);
		}
	}

	return base;
}

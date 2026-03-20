export type RecurrenceRule = {
	interval_days?: number;
	unit?: "day" | "week" | "month";
	days_of_week?: number[];
	day_of_month?: number;
	end_at?: string;
};

export function calculateNextDue(currentDue: Date, rule: RecurrenceRule): Date {
	const now = new Date();
	// Start from whichever is later: current due or now (handles overdue case)
	const next = new Date(Math.max(currentDue.getTime(), now.getTime()));

	if (rule.unit === "month") {
		next.setMonth(next.getMonth() + (rule.interval_days || 1));
		if (rule.day_of_month) next.setDate(rule.day_of_month);
	} else {
		next.setDate(next.getDate() + (rule.interval_days || 1));
	}

	// If days_of_week specified, advance to the next matching day
	if (rule.days_of_week?.length) {
		const isoDay = (d: Date) => d.getDay() || 7; // Convert Sun=0 to Sun=7
		while (!rule.days_of_week.includes(isoDay(next))) {
			next.setDate(next.getDate() + 1);
		}
	}

	return next;
}

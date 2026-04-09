export type ThoughtStatus = "open" | "resolved";

export type RecurrenceRule = {
	interval_days?: number;
	unit?: "day" | "week" | "month";
	days_of_week?: number[];
	day_of_month?: number;
	end_at?: string;
};

export type MemoryType = "fact" | "preference" | "episodic" | "procedural";

export type ThoughtMetadata = {
	type?: string;
	topics?: string[];
	people?: string[];
	action_items?: string[];
	dates_mentioned?: string[];
	source?: string;
	status?: ThoughtStatus;
	resolved_at?: string;
	location?: string;
	cost?: number;
	url?: string;
	rating?: number;
	last_completed?: string;
	completion_count?: number;
	memory_type?: MemoryType;
	[key: string]: unknown;
};

export type Thought = {
	id: string;
	content: string;
	metadata: ThoughtMetadata;
	version: number;
	due_at: string | null;
	expires_at: string | null;
	event_at: string | null;
	recurrence: RecurrenceRule | null;
	priority: number | null;
	category: string | null;
	created_at: string;
	updated_at: string;
};

export type ThoughtVersion = {
	id: string;
	thought_id: string;
	version: number;
	content: string;
	metadata: ThoughtMetadata;
	created_at: string;
	archived_at: string;
};

export type ThoughtStats = {
	total: number;
	dateRange: { from: string; to: string } | null;
	types: Record<string, number>;
	topics: Record<string, number>;
	people: Record<string, number>;
};

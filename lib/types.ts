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
	relationship?: Record<string, string>;
	project?: string;
	organization?: string;
	tools?: string[];
	sentiment?: "positive" | "negative" | "neutral";
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
	source_id: string | null;
	source_kind: string | null;
	created_at: string;
	updated_at: string;
};

export type RelationType = "updates" | "extends" | "derives" | "related";

export type ThoughtRelation = {
	id: string;
	source_id: string;
	target_id: string;
	relation_type: RelationType;
	confidence: number;
	is_latest: boolean;
	created_at: string;
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
	categories: Record<string, number>;
	overdueCount: number;
	recurringCount: number;
};

export type ThoughtFilters = {
	type?: string;
	topic?: string;
	person?: string;
	days?: number;
	status?: string;
	category?: string;
	priority?: number;
	overdue?: boolean;
	order_by?: "created_at" | "due_at" | "priority";
};

export type TopicPage = {
	id: string;
	slug: string;
	title: string;
	summary: string;
	thought_ids: string[];
	thought_count: number;
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
};

export type EntityType = "person" | "project" | "organization" | "tool" | "place";

export type Entity = {
	id: string;
	type: EntityType;
	canonical_name: string;
	aliases: string[];
	description: string | null;
	mention_count: number;
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
};

export type RelatedEntity = { name: string; type: EntityType; weight: number };

export type EntityPage = {
	id: string;
	entity_id: string;
	title: string;
	entity_type: EntityType;
	summary: string;
	thought_ids: string[];
	thought_count: number;
	related: RelatedEntity[];
	created_at: string;
	updated_at: string;
};

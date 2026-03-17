export type ThoughtMetadata = {
	type?: string;
	topics?: string[];
	people?: string[];
	action_items?: string[];
	dates_mentioned?: string[];
	source?: string;
	[key: string]: unknown;
};

export type Thought = {
	id: string;
	content: string;
	metadata: ThoughtMetadata;
	version: number;
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

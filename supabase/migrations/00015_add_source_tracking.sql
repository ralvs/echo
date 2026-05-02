-- Track external sources for captured thoughts (e.g. claude-transcript mining).
-- source_id is unique across all thoughts so the mine CLI is idempotent —
-- re-runs hit the unique index and skip without inserting duplicates.

alter table public.thoughts
	add column if not exists source_id text,
	add column if not exists source_kind text;

create unique index if not exists thoughts_source_id_idx
	on public.thoughts (source_id)
	where source_id is not null;

create index if not exists thoughts_source_kind_idx
	on public.thoughts (source_kind)
	where source_kind is not null;

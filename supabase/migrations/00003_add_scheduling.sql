-- 00003_add_scheduling.sql
-- Adds scheduling columns to thoughts: due dates, recurrence rules,
-- priority levels, and category for cross-domain task tracking.
-- These are real columns (not JSONB) because they need efficient
-- sorting, range queries, and indexing.

set search_path to public, extensions;

-- 1. Add scheduling + category columns
alter table public.thoughts
  add column if not exists due_at     timestamptz,
  add column if not exists recurrence jsonb,
  add column if not exists priority   smallint,
  add column if not exists category   text;

-- 2. Constrain priority to valid range: 0=none, 1=low, 2=medium, 3=high, 4=urgent
alter table public.thoughts
  add constraint chk_priority check (priority is null or priority between 0 and 4);

-- 3. Partial indexes — only index rows that use these features (keeps index small)

-- "What's due soon?" / "What's overdue?" sorted by urgency
create index if not exists idx_thoughts_due_at
  on public.thoughts (due_at asc nulls last)
  where due_at is not null;

-- "Show all recurring tasks"
create index if not exists idx_thoughts_recurring
  on public.thoughts (due_at asc)
  where recurrence is not null;

-- "Urgent overdue items" — priority + due date combo
create index if not exists idx_thoughts_priority_due
  on public.thoughts (priority desc, due_at asc)
  where priority is not null and priority > 0;

-- "Show all plumbing thoughts" / "All italian recipes"
create index if not exists idx_thoughts_category
  on public.thoughts (category)
  where category is not null;

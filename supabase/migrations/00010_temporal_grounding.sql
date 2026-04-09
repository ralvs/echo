-- Feature 1b: Temporal Grounding
--
-- Adds event_at column for dual-layer timestamping.
-- created_at = when the thought was captured
-- event_at   = when the described event actually happened (or will happen)
--
-- This distinction drives better temporal reasoning in search
-- (Supermemory research: 76.69% vs 45.1% for full-context baselines).

set search_path to public, extensions;

-- 1. event_at column + partial index
alter table public.thoughts
  add column if not exists event_at timestamptz;

create index if not exists idx_thoughts_event_at
  on public.thoughts(event_at)
  where event_at is not null;

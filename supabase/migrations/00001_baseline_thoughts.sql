-- 00001_baseline_thoughts.sql
-- The thoughts table predates the migration history (it was created through
-- the dashboard before 00002). This baseline reconstructs the pre-00002 state
-- so a local `supabase start` / `supabase db reset` stack can apply 00002+.
-- Everything is idempotent (if not exists / or replace), so it is a no-op
-- against the production database where these objects already exist.

create extension if not exists vector with schema extensions;

set search_path to public, extensions;

create table if not exists public.thoughts (
  id         uuid primary key default gen_random_uuid(),
  content    text not null,
  embedding  vector(1536),
  metadata   jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_thoughts_embedding
  on public.thoughts using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.thoughts enable row level security;

-- Recreated with a pinned search_path by 00006; defined here so the trigger
-- (and the later topic/entity page triggers) have it from the start.
create or replace function public.update_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger thoughts_updated_at_trigger
before update on public.thoughts
for each row execute function public.update_updated_at();

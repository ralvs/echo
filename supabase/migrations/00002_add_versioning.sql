-- 00002_add_versioning.sql
-- Adds version tracking to thoughts: a version column on the main table
-- and a thought_versions archive table for historical versions.

-- The ON DELETE CASCADE on thought_id means deleting a thought
-- automatically cleans up all its archived versions. No orphan cleanup needed.
-- Also, search_path includes extensions so the vector type resolves
-- (pgvector is installed in the extensions schema on Supabase).

set search_path to public, extensions;

-- 1. Add version column to thoughts
alter table public.thoughts
  add column if not exists version integer not null default 1;

-- 2. Create thought_versions archive table
create table if not exists public.thought_versions (
  id          uuid primary key default gen_random_uuid(),
  thought_id  uuid not null references public.thoughts(id) on delete cascade,
  version     integer not null,
  content     text,
  embedding   vector(1536),
  metadata    jsonb,
  created_at  timestamptz,      -- when the original version was created
  archived_at timestamptz default now()  -- when it was archived
);

-- 3. Index for efficient lookups by thought + version
create index if not exists idx_thought_versions_thought_version
  on public.thought_versions(thought_id, version);

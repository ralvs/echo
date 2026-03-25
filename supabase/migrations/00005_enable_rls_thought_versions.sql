-- 00005_enable_rls_thought_versions.sql
-- Enable RLS on thought_versions to prevent direct PostgREST/anon access.
-- All application access goes through the service role, which bypasses RLS.

alter table public.thought_versions enable row level security;

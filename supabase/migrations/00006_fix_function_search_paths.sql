-- 00006_fix_function_search_paths.sql
-- Fix mutable search_path security warning on public functions by pinning
-- search_path to 'public, extensions' in each function definition.

create or replace function public.match_thoughts(
  query_embedding vector,
  match_threshold double precision default 0.7,
  match_count integer default 10,
  filter jsonb default '{}'::jsonb
)
returns table(
  id uuid,
  content text,
  metadata jsonb,
  similarity double precision,
  created_at timestamptz
)
language plpgsql
set search_path = public, extensions
as $$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

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

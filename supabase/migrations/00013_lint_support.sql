-- Feature: Lint Support
-- SQL helper for near-duplicate detection used by the lint_thoughts MCP tool.

set search_path to public, extensions;

create or replace function public.find_near_duplicates(
  similarity_threshold double precision default 0.95,
  max_results integer default 20
)
returns table(
  thought_a   uuid,
  thought_b   uuid,
  content_a   text,
  content_b   text,
  similarity  double precision
)
language plpgsql
set search_path = public, extensions
as $$
begin
  return query
  select
    t1.id   as thought_a,
    t2.id   as thought_b,
    t1.content as content_a,
    t2.content as content_b,
    (1 - (t1.embedding <=> t2.embedding))::double precision as similarity
  from thoughts t1
  join thoughts t2
    on t1.id < t2.id
    and (1 - (t1.embedding <=> t2.embedding)) > similarity_threshold
  where
    (t1.is_bundle is null or t1.is_bundle = false)
    and (t2.is_bundle is null or t2.is_bundle = false)
    and (t1.expires_at is null or t1.expires_at > now())
    and (t2.expires_at is null or t2.expires_at > now())
  order by similarity desc
  limit max_results;
end;
$$;

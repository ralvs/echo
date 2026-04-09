-- Feature 1: Memory Classification & Relevance Decay
--
-- 1. Adds expires_at column for inherently time-bound thoughts
--    ("exam Friday", "meeting tomorrow"). The LLM extractor populates this
--    when content has a natural expiration.
-- 2. Updates hybrid_search to exclude expired rows at the DB level.
--
-- memory_type (fact / preference / episodic / procedural) is stored inside
-- the existing metadata JSONB column — no schema change needed for it.

set search_path to public, extensions;

-- 1. expires_at column + partial index
alter table public.thoughts
  add column if not exists expires_at timestamptz;

create index if not exists idx_thoughts_expires_at
  on public.thoughts(expires_at)
  where expires_at is not null;

-- 2. Replace hybrid_search to filter expired rows
create or replace function public.hybrid_search(
  query_text      text,
  query_embedding vector,
  match_threshold double precision default 0.3,
  match_count     integer          default 10,
  alpha           double precision default 0.7,
  filter          jsonb            default '{}'::jsonb
)
returns table(
  id          uuid,
  content     text,
  metadata    jsonb,
  similarity  double precision,
  created_at  timestamptz,
  due_at      timestamptz,
  priority    smallint,
  category    text,
  is_bundle   boolean
)
language plpgsql
set search_path = public, extensions
as $$
declare
  tsq     tsquery;
  tsq_str text;
begin
  begin
    select string_agg(lexeme, ' | ')
    into tsq_str
    from unnest(to_tsvector('english', query_text));

    if tsq_str is not null then
      tsq := to_tsquery('english', tsq_str);
    end if;
  exception when others then
    tsq := null;
  end;

  return query
  select
    t.id,
    t.content,
    t.metadata,
    (
      alpha * (1 - (t.embedding <=> query_embedding))
      + (1 - alpha) * case
          when tsq is not null and t.search_vector @@ tsq
          then ts_rank_cd(t.search_vector, tsq, 32)
          else 0.0
        end
    )::double precision as similarity,
    t.created_at,
    t.due_at,
    t.priority,
    t.category,
    t.is_bundle
  from thoughts t
  where
    (
      (1 - (t.embedding <=> query_embedding)) > match_threshold
      or (tsq is not null and t.search_vector @@ tsq)
    )
    and (filter = '{}'::jsonb or t.metadata @> filter)
    and (t.expires_at is null or t.expires_at > now())
  order by similarity desc
  limit match_count;
end;
$$;

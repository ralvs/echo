-- 00008_add_hybrid_search.sql
-- Adds full-text search (tsvector) column + GIN index + auto-maintain trigger,
-- and a hybrid_search RPC that blends vector similarity (70%) with text rank (30%).
-- The FTS index covers content + topics + category for broader keyword matching.

set search_path to public, extensions;

-- 1. tsvector column
alter table public.thoughts
  add column if not exists search_vector tsvector;

-- 2. GIN index for fast full-text lookups
create index if not exists idx_thoughts_search_vector
  on public.thoughts using gin (search_vector);

-- 3. Helper: build a weighted tsvector from a thought's fields
--    content = weight A (highest), category + topics = weight B
create or replace function public.thoughts_build_search_vector(
  _content  text,
  _metadata jsonb,
  _category text
) returns tsvector
language plpgsql immutable
set search_path = public, extensions
as $$
begin
  return
    setweight(to_tsvector('english', coalesce(_content, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(_category, '')), 'B') ||
    setweight(
      to_tsvector(
        'english',
        coalesce(
          (
            select string_agg(value, ' ')
            from jsonb_array_elements_text(
              case
                when _metadata -> 'topics' is not null
                  and jsonb_typeof(_metadata -> 'topics') = 'array'
                then _metadata -> 'topics'
                else '[]'::jsonb
              end
            )
          ),
          ''
        )
      ),
      'B'
    );
end;
$$;

-- 4. Backfill existing rows
update public.thoughts
set search_vector = public.thoughts_build_search_vector(content, metadata, category);

-- 5. Trigger to auto-maintain search_vector on INSERT or UPDATE of relevant columns
create or replace function public.thoughts_search_vector_update()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.search_vector := public.thoughts_build_search_vector(
    new.content, new.metadata, new.category
  );
  return new;
end;
$$;

create trigger thoughts_search_vector_trigger
before insert or update of content, metadata, category
on public.thoughts
for each row execute function public.thoughts_search_vector_update();

-- 6. hybrid_search RPC
--    Scores: alpha * vector_sim + (1-alpha) * ts_rank_cd (normalized, weight-aware)
--    WHERE: vector sim above threshold OR full-text match — whichever fires first
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
  tsq tsquery;
begin
  -- Gracefully handle queries that produce no valid tsquery tokens
  begin
    tsq := plainto_tsquery('english', query_text);
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
  order by similarity desc
  limit match_count;
end;
$$;

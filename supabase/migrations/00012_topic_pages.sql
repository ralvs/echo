-- Feature: Topic Pages (Compounding Layer)
-- Pre-computed LLM-maintained summary documents per active topic.
-- Updated incrementally on each capture; prepended as preamble in search results.

set search_path to public, extensions;

-- 1. topic_pages table
create table if not exists public.topic_pages (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,         -- normalized: "home-plumbing"
  title         text not null,                -- display: "Home Plumbing"
  summary       text not null,               -- LLM-compiled markdown summary
  embedding     vector(1536),                -- for semantic search against pages
  thought_ids   uuid[] not null default '{}', -- source thought IDs compiled in
  thought_count integer not null default 0,  -- denormalized for threshold checks
  metadata      jsonb not null default '{}', -- {related_pages, key_people, ...}
  search_vector tsvector,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Indexes
create index if not exists idx_topic_pages_embedding
  on public.topic_pages using ivfflat (embedding vector_cosine_ops) with (lists = 10);

create index if not exists idx_topic_pages_search_vector
  on public.topic_pages using gin (search_vector);

create index if not exists idx_topic_pages_slug
  on public.topic_pages (slug);

-- RLS
alter table public.topic_pages enable row level security;

-- 2. Auto-maintain search_vector from title + summary
create or replace function public.topic_pages_search_vector_update()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.summary, '')), 'B');
  return new;
end;
$$;

create trigger topic_pages_search_vector_trigger
before insert or update of title, summary
on public.topic_pages
for each row execute function public.topic_pages_search_vector_update();

-- 3. Auto-update updated_at
create trigger topic_pages_updated_at_trigger
before update on public.topic_pages
for each row execute function public.update_updated_at();

-- 4. search_topic_pages RPC (same 70/30 hybrid blend as hybrid_search)
create or replace function public.search_topic_pages(
  query_text      text,
  query_embedding vector,
  match_threshold double precision default 0.5,
  match_count     integer default 2
)
returns table(
  id            uuid,
  slug          text,
  title         text,
  summary       text,
  similarity    double precision,
  updated_at    timestamptz,
  thought_count integer
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
    tp.id,
    tp.slug,
    tp.title,
    tp.summary,
    (
      0.7 * (1 - (tp.embedding <=> query_embedding))
      + 0.3 * case
          when tsq is not null and tp.search_vector @@ tsq
          then ts_rank_cd(tp.search_vector, tsq, 32)
          else 0.0
        end
    )::double precision as similarity,
    tp.updated_at,
    tp.thought_count
  from topic_pages tp
  where
    (1 - (tp.embedding <=> query_embedding)) > match_threshold
    or (tsq is not null and tp.search_vector @@ tsq)
  order by similarity desc
  limit match_count;
end;
$$;

-- 5. Helper: count thoughts per topic slug (used for creation threshold check)
create or replace function public.count_thoughts_for_topic(topic_slug text)
returns integer
language sql
stable
set search_path = public, extensions
as $$
  select count(*)::integer
  from thoughts
  where
    (is_bundle is null or is_bundle = false)
    and metadata->'topics' @> to_jsonb(topic_slug);
$$;

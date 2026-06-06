-- Feature: Entity Pages (graph-backed wiki layer)
--
-- The entity analogue of topic_pages: one LLM-compiled summary per entity that
-- has crossed the mention threshold. Pages are generated artifacts — the SQL
-- tables (entities, thought_entities, entity_edges) stay the source of truth,
-- so a page can always be regenerated from scratch. Relevant entity pages are
-- prepended to search results as a compiled preamble, same as topic pages.

set search_path to public, extensions;

create table if not exists public.entity_pages (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null unique references entities(id) on delete cascade,
  title         text not null,
  entity_type   text not null,
  summary       text not null,
  embedding     vector(1536),
  thought_ids   uuid[] not null default '{}',
  thought_count integer not null default 0,
  related       jsonb not null default '[]'::jsonb, -- [{name, type, weight}]
  search_vector tsvector,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists idx_entity_pages_embedding
  on public.entity_pages using ivfflat (embedding vector_cosine_ops) with (lists = 10);

create index if not exists idx_entity_pages_search_vector
  on public.entity_pages using gin (search_vector);

create index if not exists idx_entity_pages_entity on public.entity_pages (entity_id);

alter table public.entity_pages enable row level security;

-- Maintain search_vector from title + summary
create or replace function public.entity_pages_search_vector_update()
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

create trigger entity_pages_search_vector_trigger
before insert or update of title, summary
on public.entity_pages
for each row execute function public.entity_pages_search_vector_update();

create trigger entity_pages_updated_at_trigger
before update on public.entity_pages
for each row execute function public.update_updated_at();

-- search_entity_pages — same 70/30 hybrid blend as search_topic_pages
create or replace function public.search_entity_pages(
  query_text      text,
  query_embedding vector,
  match_threshold double precision default 0.5,
  match_count     integer default 2
)
returns table(
  id            uuid,
  entity_id     uuid,
  title         text,
  entity_type   text,
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
    ep.id,
    ep.entity_id,
    ep.title,
    ep.entity_type,
    ep.summary,
    (
      0.7 * (1 - (ep.embedding <=> query_embedding))
      + 0.3 * case
          when tsq is not null and ep.search_vector @@ tsq
          then ts_rank_cd(ep.search_vector, tsq, 32)
          else 0.0
        end
    )::double precision as similarity,
    ep.updated_at,
    ep.thought_count
  from entity_pages ep
  where
    (1 - (ep.embedding <=> query_embedding)) > match_threshold
    or (tsq is not null and ep.search_vector @@ tsq)
  order by similarity desc
  limit match_count;
end;
$$;

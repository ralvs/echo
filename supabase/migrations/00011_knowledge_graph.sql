-- Feature 2: Knowledge Graph with Typed Relations
-- Feature 3: Parent Bundle Context Injection (hybrid_search returns parent_id)

set search_path to public, extensions;

-- 1. thought_relations table
create table if not exists public.thought_relations (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references thoughts(id) on delete cascade,
  target_id     uuid not null references thoughts(id) on delete cascade,
  relation_type text not null check (
    relation_type in ('updates', 'extends', 'derives', 'related')
  ),
  confidence    double precision default 1.0,
  is_latest     boolean default true,
  created_at    timestamptz default now(),
  unique(source_id, target_id, relation_type)
);

create index if not exists idx_relations_source on thought_relations(source_id);
create index if not exists idx_relations_target on thought_relations(target_id);

-- 2. Drop + recreate hybrid_search (return type changed: added event_at, parent_id)
drop function if exists public.hybrid_search(text, vector, double precision, integer, double precision, jsonb);

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
  event_at    timestamptz,
  due_at      timestamptz,
  priority    smallint,
  category    text,
  is_bundle   boolean,
  parent_id   uuid
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
    t.event_at,
    t.due_at,
    t.priority,
    t.category,
    t.is_bundle,
    t.parent_id
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

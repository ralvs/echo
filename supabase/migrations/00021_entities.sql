-- Feature: Generalized Entity Graph
--
-- Promotes the people-only concept into a general entity layer covering
-- people, projects, organizations, tools, and places. Entities are derived
-- graph nodes projected from thought metadata (people, project, organization,
-- location, tools). The `people` table remains the curated identity/alias
-- store used during extraction; person entities are kept consistent because
-- metadata.people already resolves to canonical names via that table.
--
-- Three tables:
--   entities         — deduped nodes (type + canonical_name unique)
--   thought_entities — evidence links (which thought mentions which entity)
--   entity_edges     — undirected co-occurrence edges with a weight

set search_path to public, extensions;

-- 1. entities
create table if not exists public.entities (
  id             uuid primary key default gen_random_uuid(),
  type           text not null check (type in ('person', 'project', 'organization', 'tool', 'place')),
  canonical_name text not null,
  aliases        text[] not null default '{}',
  description    text,
  embedding      vector(1536),
  mention_count  integer not null default 0,
  metadata       jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (type, canonical_name)
);

create index if not exists idx_entities_type on public.entities (type);
create index if not exists idx_entities_aliases on public.entities using gin (aliases);
create index if not exists idx_entities_embedding
  on public.entities using ivfflat (embedding vector_cosine_ops) with (lists = 10);

create trigger entities_updated_at_trigger
before update on public.entities
for each row execute function public.update_updated_at();

alter table public.entities enable row level security;

-- 2. thought_entities (evidence links)
create table if not exists public.thought_entities (
  thought_id uuid not null references thoughts(id) on delete cascade,
  entity_id  uuid not null references entities(id) on delete cascade,
  confidence double precision not null default 1.0,
  created_at timestamptz not null default now(),
  primary key (thought_id, entity_id)
);

create index if not exists idx_thought_entities_entity on public.thought_entities (entity_id);
create index if not exists idx_thought_entities_thought on public.thought_entities (thought_id);

alter table public.thought_entities enable row level security;

-- 3. entity_edges (undirected, canonicalized so source_id < target_id)
create table if not exists public.entity_edges (
  id         uuid primary key default gen_random_uuid(),
  source_id  uuid not null references entities(id) on delete cascade,
  target_id  uuid not null references entities(id) on delete cascade,
  edge_type  text not null default 'co_occurs_with',
  weight     integer not null default 1,
  confidence double precision not null default 1.0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, target_id, edge_type),
  check (source_id <> target_id)
);

create index if not exists idx_entity_edges_source on public.entity_edges (source_id);
create index if not exists idx_entity_edges_target on public.entity_edges (target_id);

alter table public.entity_edges enable row level security;

-- 4. Maintain entities.mention_count from thought_entities links.
--    Counts distinct thoughts; only INSERT/DELETE shift the count so an
--    idempotent upsert (which performs an UPDATE on conflict) never double-counts.
create or replace function public.entities_mention_count_update()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if (tg_op = 'INSERT') then
    update entities set mention_count = mention_count + 1, updated_at = now()
    where id = new.entity_id;
  elsif (tg_op = 'DELETE') then
    update entities set mention_count = greatest(0, mention_count - 1), updated_at = now()
    where id = old.entity_id;
  end if;
  return null;
end;
$$;

create trigger thought_entities_count_trigger
after insert or delete on public.thought_entities
for each row execute function public.entities_mention_count_update();

-- 5. upsert_entity — get-or-create a node by (type, canonical_name), returns id.
create or replace function public.upsert_entity(p_type text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  eid uuid;
begin
  select id into eid from entities where type = p_type and canonical_name = p_name;
  if eid is not null then
    return eid;
  end if;

  insert into entities (type, canonical_name)
  values (p_type, p_name)
  on conflict (type, canonical_name) do update set updated_at = now()
  returning id into eid;

  return eid;
end;
$$;

-- 6. upsert_entity_edge — increment an undirected co-occurrence edge weight.
create or replace function public.upsert_entity_edge(
  p_source uuid,
  p_target uuid,
  p_type   text default 'co_occurs_with'
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s uuid;
  t uuid;
begin
  if p_source = p_target then
    return;
  end if;

  if p_source < p_target then
    s := p_source; t := p_target;
  else
    s := p_target; t := p_source;
  end if;

  insert into entity_edges (source_id, target_id, edge_type, weight)
  values (s, t, p_type, 1)
  on conflict (source_id, target_id, edge_type)
  do update set weight = entity_edges.weight + 1, updated_at = now();
end;
$$;

-- 7. Seed person entities from the curated people table (names + aliases only;
--    mention_count is rebuilt as thought_entities links are created via backfill).
insert into public.entities (type, canonical_name, aliases)
select 'person', canonical_name, aliases
from public.people
on conflict (type, canonical_name) do nothing;

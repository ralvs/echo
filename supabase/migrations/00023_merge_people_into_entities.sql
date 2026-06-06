-- Feature: collapse the people table into entities (single source of truth)
--
-- 00021 seeded person entities (with aliases) from the people table but kept
-- people around as a parallel store. This finishes the job: the role column —
-- the only people data not already on entities — is folded into
-- entities.metadata, the stats RPC is repointed at entities, and the people
-- table is dropped. People are now simply `entities` rows with type = 'person'.

set search_path to public, extensions;

-- 1. Fold each person's role into entities.metadata.role.
update public.entities e
set metadata = e.metadata || jsonb_build_object('role', p.role)
from public.people p
where e.type = 'person'
  and e.canonical_name = p.canonical_name
  and p.role is not null;

-- Safety net: ensure every people row exists as an entity before we drop it
-- (covers any person added after the 00021 seed ran).
insert into public.entities (type, canonical_name, aliases, metadata)
select 'person', p.canonical_name, p.aliases, jsonb_build_object('role', p.role)
from public.people p
on conflict (type, canonical_name) do nothing;

-- 2. Repoint get_thought_stats people aggregation at entities (type = 'person').
create or replace function get_thought_stats()
returns json
language plpgsql
security definer
as $$
declare
  total_count  integer;
  date_range   json;
  types_json   json;
  topics_json  json;
  people_json  json;
  cats_json    json;
  overdue_cnt  integer;
  recur_cnt    integer;
begin
  select count(*) into total_count
  from thoughts where (is_bundle is null or is_bundle = false);

  select json_build_object('from', min(created_at), 'to', max(created_at))
  into date_range
  from thoughts where (is_bundle is null or is_bundle = false);

  select json_object_agg(t, cnt) into types_json
  from (
    select metadata->>'type' as t, count(*) as cnt
    from thoughts
    where (is_bundle is null or is_bundle = false)
      and metadata->>'type' is not null
    group by metadata->>'type'
  ) x;

  select json_object_agg(tag, cnt) into topics_json
  from (
    select tag, count(*) as cnt
    from thoughts,
         jsonb_array_elements_text(coalesce(metadata->'topics', '[]'::jsonb)) as tag
    where (is_bundle is null or is_bundle = false)
    group by tag
  ) x;

  -- Resolve people via the entities table; aliases collapse to canonical name.
  select json_object_agg(canonical_name, cnt) into people_json
  from (
    select p.canonical_name, count(*) as cnt
    from thoughts t,
         jsonb_array_elements_text(coalesce(t.metadata->'people', '[]'::jsonb)) as person
    join entities p
      on p.type = 'person'
     and (person = p.canonical_name or person = any(p.aliases))
    where (t.is_bundle is null or t.is_bundle = false)
    group by p.canonical_name
  ) x;

  select json_object_agg(cat, cnt) into cats_json
  from (
    select category as cat, count(*) as cnt
    from thoughts
    where (is_bundle is null or is_bundle = false)
      and category is not null
    group by category
  ) x;

  select count(*) into overdue_cnt
  from thoughts
  where (is_bundle is null or is_bundle = false)
    and due_at < now()
    and metadata->>'status' = 'open';

  select count(*) into recur_cnt
  from thoughts
  where (is_bundle is null or is_bundle = false)
    and recurrence is not null;

  return json_build_object(
    'total',          total_count,
    'dateRange',      case when total_count > 0 then date_range else null end,
    'types',          coalesce(types_json,  '{}'::json),
    'topics',         coalesce(topics_json, '{}'::json),
    'people',         coalesce(people_json, '{}'::json),
    'categories',     coalesce(cats_json,   '{}'::json),
    'overdueCount',   overdue_cnt,
    'recurringCount', recur_cnt
  );
end;
$$;

-- 3. Drop the now-redundant people table.
drop table if exists public.people;

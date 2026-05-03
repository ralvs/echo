create table if not exists people (
  id             uuid        primary key default gen_random_uuid(),
  canonical_name text        not null unique,
  role           text        not null,
  aliases        text[]      not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Fast lookup for alias resolution during capture
create index if not exists people_aliases_gin on people using gin (aliases);

-- The fire-and-forget upsert pipeline failed silently on some captures,
-- leaving Andrea absent from the table and Bella without her "daughter" alias.
-- This migration corrects both records directly.

INSERT INTO people (canonical_name, role, aliases)
VALUES ('Andrea', 'mother-in-law', ARRAY['mother-in-law'])
ON CONFLICT (canonical_name) DO UPDATE
  SET role    = EXCLUDED.role,
      aliases = EXCLUDED.aliases,
      updated_at = now();

UPDATE people
SET role       = 'daughter',
    aliases    = ARRAY['daughter'],
    updated_at = now()
WHERE canonical_name = 'Bella';

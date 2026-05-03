-- One-time backfill: populate the people table from existing thought metadata.
--
-- Only proper names (first character is uppercase A-Z) are inserted as canonical
-- entries. Role-based terms like "daughter" or "mother-in-law" are intentionally
-- skipped — they remain as raw JSONB entries until the user explicitly links them
-- (e.g. "my daughter is called Bella"), at which point the capture pipeline
-- upserts them as aliases and runs the embedding backfill.
--
-- For each proper name, if any thought's relationship metadata maps that name to
-- a role (e.g. {"Bella": "daughter"}), that role is used and also added as an
-- alias so future captures that mention "daughter" resolve to "Bella".

INSERT INTO people (canonical_name, role, aliases)
SELECT
  person,
  COALESCE(found_role, 'contact'),
  CASE
    WHEN found_role IS NOT NULL AND found_role != ''
      THEN ARRAY[lower(found_role)]
    ELSE '{}'::text[]
  END
FROM (
  SELECT DISTINCT
    person,
    (
      SELECT t2.metadata -> 'relationship' ->> person
      FROM   thoughts t2
      WHERE  t2.metadata -> 'relationship' ? person
        AND  (t2.is_bundle IS NULL OR t2.is_bundle = false)
      LIMIT  1
    ) AS found_role
  FROM
    thoughts,
    jsonb_array_elements_text(
      COALESCE(metadata -> 'people', '[]'::jsonb)
    ) AS person
  WHERE (is_bundle IS NULL OR is_bundle = false)
    AND person IS NOT NULL
    AND person != ''
    AND person ~ '^[A-Z]'   -- proper names only
) subq
ON CONFLICT (canonical_name) DO NOTHING;

-- One-time backfill: populate the people table from existing thought metadata.
--
-- Only proper names (first character is uppercase A-Z) are inserted as canonical
-- entries. Role-based terms like "daughter" or "mother-in-law" are intentionally
-- skipped — they remain as raw JSONB entries until the user explicitly links them
-- (e.g. "my daughter is called Bella"), at which point the capture pipeline
-- upserts them as aliases and runs the embedding backfill.
--
-- Aliases are intentionally NOT pre-populated here. If we seeded aliases from
-- existing relationship metadata, upsertPerson() would find them already present
-- and skip the embedding backfill — leaving old thoughts unrewritten. Aliases are
-- assigned exclusively through the capture pipeline so backfill always runs.

INSERT INTO people (canonical_name, role)
SELECT
  person,
  COALESCE(found_role, 'contact')
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

-- Update get_thought_stats to source people from the canonical people table
-- instead of scanning raw JSONB metadata. This means:
--   - Only registered people (canonical names) appear in the card
--   - Role-based entries like "mother-in-law" or "daughter" no longer show up
--   - Mention counts reflect backfilled canonical names in metadata.people
CREATE OR REPLACE FUNCTION get_thought_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  total_count  INTEGER;
  date_range   JSON;
  types_json   JSON;
  topics_json  JSON;
  people_json  JSON;
  cats_json    JSON;
  overdue_cnt  INTEGER;
  recur_cnt    INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO total_count
  FROM thoughts
  WHERE (is_bundle IS NULL OR is_bundle = false);

  SELECT json_build_object('from', MIN(created_at), 'to', MAX(created_at))
  INTO date_range
  FROM thoughts
  WHERE (is_bundle IS NULL OR is_bundle = false);

  SELECT json_object_agg(t, cnt)
  INTO types_json
  FROM (
    SELECT metadata->>'type' AS t, COUNT(*) AS cnt
    FROM thoughts
    WHERE (is_bundle IS NULL OR is_bundle = false)
      AND metadata->>'type' IS NOT NULL
    GROUP BY metadata->>'type'
  ) x;

  SELECT json_object_agg(tag, cnt)
  INTO topics_json
  FROM (
    SELECT tag, COUNT(*) AS cnt
    FROM thoughts,
         jsonb_array_elements_text(COALESCE(metadata->'topics', '[]'::jsonb)) AS tag
    WHERE (is_bundle IS NULL OR is_bundle = false)
    GROUP BY tag
  ) x;

  -- Source people from the canonical people table.
  -- Counts come from thoughts whose metadata.people contains the canonical name
  -- (backfill ensures role-based strings like "mother-in-law" are resolved before storage).
  SELECT json_object_agg(p.canonical_name, COALESCE(counts.cnt, 0))
  INTO people_json
  FROM people p
  LEFT JOIN (
    SELECT person, COUNT(*) AS cnt
    FROM thoughts,
         jsonb_array_elements_text(COALESCE(metadata->'people', '[]'::jsonb)) AS person
    WHERE (is_bundle IS NULL OR is_bundle = false)
    GROUP BY person
  ) counts ON counts.person = p.canonical_name;

  SELECT json_object_agg(cat, cnt)
  INTO cats_json
  FROM (
    SELECT category AS cat, COUNT(*) AS cnt
    FROM thoughts
    WHERE (is_bundle IS NULL OR is_bundle = false)
      AND category IS NOT NULL
    GROUP BY category
  ) x;

  SELECT COUNT(*)
  INTO overdue_cnt
  FROM thoughts
  WHERE (is_bundle IS NULL OR is_bundle = false)
    AND due_at < NOW()
    AND metadata->>'status' = 'open';

  SELECT COUNT(*)
  INTO recur_cnt
  FROM thoughts
  WHERE (is_bundle IS NULL OR is_bundle = false)
    AND recurrence IS NOT NULL;

  RETURN json_build_object(
    'total',          total_count,
    'dateRange',      CASE WHEN total_count > 0 THEN date_range ELSE NULL END,
    'types',          COALESCE(types_json,  '{}'::json),
    'topics',         COALESCE(topics_json, '{}'::json),
    'people',         COALESCE(people_json, '{}'::json),
    'categories',     COALESCE(cats_json,   '{}'::json),
    'overdueCount',   overdue_cnt,
    'recurringCount', recur_cnt
  );
END;
$$;

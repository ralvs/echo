-- Auto-decomposition support: parent references and bundle flag

-- Parent reference for decomposed child thoughts
ALTER TABLE thoughts
ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES thoughts(id) ON DELETE SET NULL;

-- Index for efficiently querying children of a parent
CREATE INDEX IF NOT EXISTS idx_thoughts_parent_id
ON thoughts(parent_id)
WHERE parent_id IS NOT NULL;

-- Flag to distinguish bundle parents from regular thoughts
-- This avoids parent thoughts polluting search results
ALTER TABLE thoughts
ADD COLUMN IF NOT EXISTS is_bundle boolean DEFAULT false;

-- 0008b — the two archive columns that were in the second draft of 0008 but not the version that was run.
-- Additive only; safe to re-run.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cases_archived ON cases(archived_at) WHERE archived_at IS NOT NULL;

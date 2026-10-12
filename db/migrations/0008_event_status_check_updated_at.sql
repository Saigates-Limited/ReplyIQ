-- Follow-ups after 0006/0007 review (additive / constraint-only; no data changed):
--  1. CHECK on amazon_events.status limiting it to the agreed values.
--  2. updated_at maintained automatically by a trigger on every UPDATE (cases, messages, drafts, amazon_events).
--  3. Cases are archived, never deleted: a soft-archive column. (There is no delete endpoint in the app.)

-- 1. Status values per tracker:
--    A-to-Z / chargeback: open | info_requested | response_sent | won | lost | closed
--    returns:             requested | received | inspected | refunded | closed
ALTER TABLE amazon_events DROP CONSTRAINT IF EXISTS amazon_events_status_check;
ALTER TABLE amazon_events ADD CONSTRAINT amazon_events_status_check
  CHECK (status IN ('open','info_requested','response_sent','won','lost','closed',
                    'requested','received','inspected','refunded'));

-- 2. updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cases_updated_at ON cases;
CREATE TRIGGER trg_cases_updated_at BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_drafts_updated_at ON drafts;
CREATE TRIGGER trg_drafts_updated_at BEFORE UPDATE ON drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_events_updated_at ON amazon_events;
CREATE TRIGGER trg_events_updated_at BEFORE UPDATE ON amazon_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Soft archive (managers only, enforced in the API). Archived cases leave the queue but keep all messages, drafts and events.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cases_archived ON cases(archived_at) WHERE archived_at IS NOT NULL;

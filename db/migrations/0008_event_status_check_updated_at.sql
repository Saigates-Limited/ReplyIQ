-- 0008 — follow-ups from the 0006/0007 review.
-- Additive / protective only: no data is deleted, rewritten or updated.
-- Safe to re-run (every statement is IF NOT EXISTS / OR REPLACE / DROP-IF-EXISTS-then-CREATE on constraints & triggers).

-- 1. amazon_events.status limited to the agreed values, per tracker:
--    A-to-Z & chargebacks: open -> info_requested -> response_sent -> won / lost / closed
--    Returns:              requested -> received -> inspected -> refunded / closed
ALTER TABLE amazon_events DROP CONSTRAINT IF EXISTS amazon_events_status_check;
ALTER TABLE amazon_events ADD CONSTRAINT amazon_events_status_check CHECK (
  (kind IN ('atoz_claim','atoz_info_request','atoz_decision','chargeback')
     AND status IN ('open','info_requested','response_sent','won','lost','closed'))
  OR
  (kind = 'return_request'
     AND status IN ('requested','received','inspected','refunded','closed'))
);

-- 2. updated_at maintained by the database on every UPDATE (cases, drafts, amazon_events),
--    so no code path can forget it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cases_updated_at ON cases;
CREATE TRIGGER trg_cases_updated_at BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_drafts_updated_at ON drafts;
CREATE TRIGGER trg_drafts_updated_at BEFORE UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_events_updated_at ON amazon_events;
CREATE TRIGGER trg_events_updated_at BEFORE UPDATE ON amazon_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Cases are archived, never deleted.
--    3a. Soft-archive columns (managers only; enforced in the API). Archived cases leave the queue
--        but keep every message, draft and Amazon event.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cases_archived ON cases(archived_at) WHERE archived_at IS NOT NULL;

--    3b. The database itself refuses DELETE on cases, so the ON DELETE CASCADE on amazon_events / messages
--        can never fire from a mistaken query or a future bug. (The application has no delete route.)
CREATE OR REPLACE FUNCTION prevent_case_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cases are archived, not deleted (case id %). Use POST /api/cases/:id/archive.', OLD.id;
END $$;

DROP TRIGGER IF EXISTS trg_cases_no_delete ON cases;
CREATE TRIGGER trg_cases_no_delete BEFORE DELETE ON cases
  FOR EACH ROW EXECUTE FUNCTION prevent_case_delete();

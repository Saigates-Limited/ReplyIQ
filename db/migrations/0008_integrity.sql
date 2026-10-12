-- Integrity follow-ups (additive / constraint-only; no data rewritten).

-- 1. amazon_events.status limited to the agreed values.
--    A-to-Z & chargebacks: open -> info_requested/response_sent -> won / lost / closed
--    Returns:              requested -> received -> inspected -> refunded / closed
ALTER TABLE amazon_events DROP CONSTRAINT IF EXISTS amazon_events_status_check;
ALTER TABLE amazon_events ADD CONSTRAINT amazon_events_status_check CHECK (
  (kind IN ('atoz_claim','atoz_info_request','atoz_decision','chargeback')
     AND status IN ('open','info_requested','response_sent','won','lost','closed'))
  OR
  (kind = 'return_request'
     AND status IN ('requested','received','inspected','refunded','closed'))
);

-- 2. updated_at maintained by the database on every UPDATE (not left to application code).
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

-- 3. Cases are archived (status = 'resolved'), never deleted.
--    The application has no delete route; this trigger makes the database refuse it too,
--    so a mistaken query or a future bug cannot cascade into messages, drafts or amazon_events.
CREATE OR REPLACE FUNCTION prevent_case_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cases are archived, not deleted. Set status = ''resolved'' instead (case id %).', OLD.id;
END $$;

DROP TRIGGER IF EXISTS trg_cases_no_delete ON cases;
CREATE TRIGGER trg_cases_no_delete BEFORE DELETE ON cases
  FOR EACH ROW EXECUTE FUNCTION prevent_case_delete();

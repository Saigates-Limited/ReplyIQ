-- Hardening follow-ups (additive / constraint only; no data changes).

-- 1. amazon_events.status limited to the agreed values.
--    A-to-Z & chargeback: open -> info_requested -> response_sent -> won / lost / closed
--    Returns:             requested -> received -> inspected -> refunded / closed
ALTER TABLE amazon_events DROP CONSTRAINT IF EXISTS amazon_events_status_check;
ALTER TABLE amazon_events ADD CONSTRAINT amazon_events_status_check
  CHECK (status IN ('open','info_requested','response_sent','won','lost','closed',
                    'requested','received','inspected','refunded'));

-- 2. updated_at is set automatically whenever a row changes (cases, messages-free tables with updated_at).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_amazon_events_updated_at ON amazon_events;
CREATE TRIGGER trg_amazon_events_updated_at BEFORE UPDATE ON amazon_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_cases_updated_at ON cases;
CREATE TRIGGER trg_cases_updated_at BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_drafts_updated_at ON drafts;
CREATE TRIGGER trg_drafts_updated_at BEFORE UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Cases are never deleted by the application (there is no delete endpoint; cases are
--    archived via status = 'resolved'). This trigger makes that a database rule too:
--    a case row can only be deleted by a role-bypassing superuser, never by the app connection.
CREATE OR REPLACE FUNCTION prevent_case_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cases are archived (status = resolved), not deleted. Case % blocked.', OLD.id;
END $$;
DROP TRIGGER IF EXISTS trg_cases_no_delete ON cases;
CREATE TRIGGER trg_cases_no_delete BEFORE DELETE ON cases
  FOR EACH ROW EXECUTE FUNCTION prevent_case_delete();

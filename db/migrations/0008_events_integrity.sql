-- Follow-ups from the 0006 review: status CHECK on amazon_events, automatic updated_at,
-- and cases are archived (status = 'resolved'), never deleted.
-- Additive / protective only: no DROP, DELETE, UPDATE or data rewrite.

-- 1. Restrict amazon_events.status to the agreed values.
--    A-to-Z & chargeback: open -> info_requested -> response_sent -> won / lost / closed
--    Returns:             requested -> received -> inspected -> refunded / closed
ALTER TABLE amazon_events DROP CONSTRAINT IF EXISTS amazon_events_status_check;
ALTER TABLE amazon_events ADD CONSTRAINT amazon_events_status_check
  CHECK (status IN ('open','info_requested','response_sent','won','lost','closed',
                    'requested','received','inspected','refunded'));

-- 2. updated_at maintained by the database, not by application code.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_amazon_events_updated ON amazon_events;
CREATE TRIGGER trg_amazon_events_updated BEFORE UPDATE ON amazon_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_cases_updated ON cases;
CREATE TRIGGER trg_cases_updated BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_drafts_updated ON drafts;
CREATE TRIGGER trg_drafts_updated BEFORE UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Cases are archived, never deleted. The application has no delete route; this guard
--    makes the database refuse a DELETE on cases unless the session explicitly opts in
--    (SET LOCAL replyiq.allow_case_delete = 'on'), which only a manager-run maintenance
--    script would ever do. Protects the amazon_events / messages / drafts history.
CREATE OR REPLACE FUNCTION prevent_case_delete() RETURNS trigger AS $$
BEGIN
  IF current_setting('replyiq.allow_case_delete', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Cases are archived (status = resolved), not deleted. Case % blocked.', OLD.id
      USING HINT = 'A manager maintenance script may SET LOCAL replyiq.allow_case_delete = ''on'' inside a transaction.';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cases_no_delete ON cases;
CREATE TRIGGER trg_cases_no_delete BEFORE DELETE ON cases
  FOR EACH ROW EXECUTE FUNCTION prevent_case_delete();

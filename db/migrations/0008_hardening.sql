-- Hardening follow-ups from the 0006 review. Additive only: adds a CHECK, triggers and a delete guard.
-- Nothing is dropped, deleted or rewritten.

-- 1. amazon_events.status limited to the agreed values
--    A-to-Z / chargeback: open | info_requested | response_sent | won | lost | closed
--    Returns:             requested | received | inspected | refunded | closed
ALTER TABLE amazon_events DROP CONSTRAINT IF EXISTS amazon_events_status_check; -- no-op on first run (constraint does not exist yet)
ALTER TABLE amazon_events ADD CONSTRAINT amazon_events_status_check
  CHECK (status IN ('open','info_requested','response_sent','won','lost','closed','requested','received','inspected','refunded'));

-- 2. updated_at is set automatically whenever a row changes
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cases_updated_at ON cases;           -- re-runnable; only replaces the trigger definition
CREATE TRIGGER trg_cases_updated_at BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_drafts_updated_at ON drafts;
CREATE TRIGGER trg_drafts_updated_at BEFORE UPDATE ON drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_events_updated_at ON amazon_events;
CREATE TRIGGER trg_events_updated_at BEFORE UPDATE ON amazon_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Cases are archived (status = 'resolved'), never deleted.
--    ReplyIQ has no delete endpoint; this trigger makes the database refuse a delete from any client
--    (including the SQL Editor) unless the session explicitly opts in with:
--      SET LOCAL replyiq.allow_case_delete = 'on';   -- manager-only, run deliberately inside a transaction
CREATE OR REPLACE FUNCTION guard_case_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('replyiq.allow_case_delete', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Cases are archived, not deleted. Set status = ''resolved'' instead. (case % / %)', OLD.id, OLD.case_ref
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_cases_no_delete ON cases;
CREATE TRIGGER trg_cases_no_delete BEFORE DELETE ON cases FOR EACH ROW EXECUTE FUNCTION guard_case_delete();

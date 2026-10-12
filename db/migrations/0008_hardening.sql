-- 0008 — database-level guards (applied to production 2026-10-12). Additive/protective only. Safe to re-run.
-- Archive columns are in 0008b_archive_columns.sql.

-- 1. amazon_events.status limited to the agreed values, per tracker
ALTER TABLE public.amazon_events DROP CONSTRAINT IF EXISTS amazon_events_status_check;
ALTER TABLE public.amazon_events ADD CONSTRAINT amazon_events_status_check CHECK (
  (kind IN ('atoz_claim','atoz_info_request','atoz_decision','chargeback')
     AND status IN ('open','info_requested','response_sent','won','lost','closed'))
  OR
  (kind = 'return_request'
     AND status IN ('requested','received','inspected','refunded','closed'))
);

-- 2. updated_at maintained by the database on every UPDATE
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cases_updated_at ON public.cases;
CREATE TRIGGER trg_cases_updated_at BEFORE UPDATE ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_drafts_updated_at ON public.drafts;
CREATE TRIGGER trg_drafts_updated_at BEFORE UPDATE ON public.drafts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_events_updated_at ON public.amazon_events;
CREATE TRIGGER trg_events_updated_at BEFORE UPDATE ON public.amazon_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Cases are archived, never deleted: the database refuses DELETE on cases
CREATE OR REPLACE FUNCTION public.prevent_case_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cases are archived, not deleted (case id %). Use Archive in ReplyIQ.', OLD.id;
END $$;

DROP TRIGGER IF EXISTS trg_cases_no_delete ON public.cases;
CREATE TRIGGER trg_cases_no_delete BEFORE DELETE ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.prevent_case_delete();

-- 4. Verification: should return 4 triggers + 1 constraint
SELECT 'trigger' AS kind, tgname AS name FROM pg_trigger
 WHERE tgname IN ('trg_cases_updated_at','trg_drafts_updated_at','trg_events_updated_at','trg_cases_no_delete')
UNION ALL
SELECT 'constraint', conname FROM pg_constraint WHERE conname = 'amazon_events_status_check';

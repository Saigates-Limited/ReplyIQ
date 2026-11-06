-- 0018: Returns are archived, never deleted (same guard as cases, migration 0008).
-- - returns.archived_at / archived_by: manager-only archive in the app; archived rows hidden from lists and counts,
--   still visible in "Archived" view, exports and the case panel history.
-- - BEFORE DELETE triggers on returns, return_items and return_photos refuse any DELETE, so a deleted return
--   can never take its phones and photo links with it (previously ON DELETE CASCADE did exactly that).
-- Safe to re-run.

ALTER TABLE public.returns ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE public.returns ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_returns_archived ON public.returns (archived_at) WHERE archived_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_return_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Returns are archived, not deleted (% id %). Use Archive in ReplyIQ.', TG_TABLE_NAME, OLD.id;
END $$;

DROP TRIGGER IF EXISTS trg_returns_no_delete ON public.returns;
CREATE TRIGGER trg_returns_no_delete BEFORE DELETE ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.prevent_return_delete();

DROP TRIGGER IF EXISTS trg_return_items_no_delete ON public.return_items;
CREATE TRIGGER trg_return_items_no_delete BEFORE DELETE ON public.return_items
  FOR EACH ROW EXECUTE FUNCTION public.prevent_return_delete();

DROP TRIGGER IF EXISTS trg_return_photos_no_delete ON public.return_photos;
CREATE TRIGGER trg_return_photos_no_delete BEFORE DELETE ON public.return_photos
  FOR EACH ROW EXECUTE FUNCTION public.prevent_return_delete();

-- Deadline for "Update customer": the app stamps status_changed_at whenever a case's status changes
-- (single edit, bulk action, resolve). Cases in update_customer are due 24 h after that stamp.
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
UPDATE public.cases SET status_changed_at = updated_at WHERE status_changed_at IS NULL AND status = 'update_customer';

-- Check: expect 3 rows
SELECT tgname, tgrelid::regclass AS "table" FROM pg_trigger
 WHERE tgname IN ('trg_returns_no_delete','trg_return_items_no_delete','trg_return_photos_no_delete') ORDER BY 1;

-- 0013 — Multiple Gmail mailboxes. gmail_connection was a single row (id = 1); it becomes a table of mailboxes
-- with a label (e.g. "Manager" / "Agent"). Every case/message/sync run records the mailbox it came through so
-- replies always go out from the same address the customer wrote to. Existing data is attributed to mailbox 1.
-- Additive; safe to re-run.

-- 1. Lift the single-row restriction and give id a real sequence
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.gmail_connection'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE public.gmail_connection DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
CREATE SEQUENCE IF NOT EXISTS public.gmail_connection_id_seq;
ALTER TABLE public.gmail_connection ALTER COLUMN id SET DEFAULT nextval('public.gmail_connection_id_seq');
SELECT setval('public.gmail_connection_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM public.gmail_connection), 1));

-- 2. Mailbox metadata
ALTER TABLE public.gmail_connection ADD COLUMN IF NOT EXISTS label      TEXT NOT NULL DEFAULT 'Mailbox';
ALTER TABLE public.gmail_connection ADD COLUMN IF NOT EXISTS enabled    BOOLEAN NOT NULL DEFAULT TRUE;   -- included in the 15-min poll
ALTER TABLE public.gmail_connection ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE; -- used for cases with no mailbox (manual cases)
CREATE UNIQUE INDEX IF NOT EXISTS uq_gmail_connection_email ON public.gmail_connection (lower(email_address));
UPDATE public.gmail_connection SET label = 'Agent', is_default = TRUE WHERE id = 1 AND label = 'Mailbox';

-- 3. Which mailbox each thing came through
ALTER TABLE public.cases         ADD COLUMN IF NOT EXISTS mailbox_id INTEGER REFERENCES public.gmail_connection(id) ON DELETE SET NULL;
ALTER TABLE public.messages      ADD COLUMN IF NOT EXISTS mailbox_id INTEGER REFERENCES public.gmail_connection(id) ON DELETE SET NULL;
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS mailbox_id INTEGER REFERENCES public.gmail_connection(id) ON DELETE SET NULL;
ALTER TABLE public.sync_runs     ADD COLUMN IF NOT EXISTS mailbox_id INTEGER REFERENCES public.gmail_connection(id) ON DELETE SET NULL;
ALTER TABLE public.oauth_states  ADD COLUMN IF NOT EXISTS label TEXT;   -- label chosen before the Google consent screen
CREATE INDEX IF NOT EXISTS idx_cases_mailbox ON public.cases(mailbox_id);

-- Everything imported so far came through mailbox 1 (the only one that existed)
UPDATE public.cases    SET mailbox_id = 1 WHERE mailbox_id IS NULL AND gmail_thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.gmail_connection WHERE id = 1);
UPDATE public.messages SET mailbox_id = 1 WHERE mailbox_id IS NULL AND gmail_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.gmail_connection WHERE id = 1);

-- Verification
SELECT 'column' AS kind, table_name || '.' || column_name AS name FROM information_schema.columns
 WHERE (table_name = 'gmail_connection' AND column_name IN ('label','enabled','is_default'))
    OR (table_name IN ('cases','messages','amazon_events','sync_runs') AND column_name = 'mailbox_id')
    OR (table_name = 'oauth_states' AND column_name = 'label')
UNION ALL
SELECT 'check_constraints_left', COUNT(*)::text FROM pg_constraint WHERE conrelid = 'public.gmail_connection'::regclass AND contype = 'c'
UNION ALL
SELECT 'mailboxes', id || ' ' || label || ' ' || email_address || CASE WHEN is_default THEN ' (default)' ELSE '' END FROM public.gmail_connection
ORDER BY 1, 2;

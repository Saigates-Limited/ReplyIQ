-- 0009b — marker so the one-off attachment backfill knows which imported messages have been scanned. Additive.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS attachments_checked_at TIMESTAMPTZ;
SELECT column_name FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'attachments_checked_at';

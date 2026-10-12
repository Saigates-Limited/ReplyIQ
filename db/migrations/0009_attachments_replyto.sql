-- 0009 — attachment metadata (files stay in Gmail until R2 is enabled) and chargeback Reply-To verification.
-- Additive only; safe to re-run.

CREATE TABLE IF NOT EXISTS public.attachments (
  id              SERIAL PRIMARY KEY,
  message_id      INTEGER NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  case_id         INTEGER NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  inline          BOOLEAN NOT NULL DEFAULT FALSE,
  source          TEXT NOT NULL DEFAULT 'gmail',        -- gmail | upload
  gmail_message_id TEXT,                                 -- where the bytes live (Gmail)
  gmail_attachment_id TEXT,
  r2_key          TEXT,                                  -- filled when copied to / uploaded into R2 (Step C part 2)
  amazon_allowed  BOOLEAN NOT NULL DEFAULT TRUE,         -- passes Amazon's type rules
  uploaded_by     INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gmail_message_id, gmail_attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_attachments_case ON public.attachments(case_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON public.attachments(message_id);

-- Chargeback notices: what Amazon's Reply-To actually is, and whether it is a real mailbox we may email.
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS reply_to_status TEXT;  -- unverified | noreply | mailbox
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS reply_to_checked_at TIMESTAMPTZ;

-- Verification
SELECT 'table' AS kind, 'attachments' AS name WHERE to_regclass('public.attachments') IS NOT NULL
UNION ALL
SELECT 'column', column_name FROM information_schema.columns WHERE table_name = 'amazon_events' AND column_name IN ('reply_to_status','reply_to_checked_at');

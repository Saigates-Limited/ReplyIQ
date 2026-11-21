-- 0027 Replies while the office is closed (weekends and UK bank holidays), 21 Nov 2026.
-- One row per customer message answered (or deliberately not answered) while closed. message_id is unique so a message is never answered twice.
CREATE TABLE IF NOT EXISTS public.auto_replies (
  id             BIGSERIAL PRIMARY KEY,
  case_id        INTEGER NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  message_id     INTEGER NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'pending' CHECK (kind IN ('pending','full','holding','skipped','failed')),
  closed_reason  TEXT,
  detail         TEXT,
  draft_id       INTEGER REFERENCES public.drafts(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auto_replies_case ON public.auto_replies (case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_replies_at   ON public.auto_replies (created_at DESC);
-- Which drafts the closed-day run wrote: full = routine reply sent; holding = holding reply sent; held = full draft left for staff.
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS auto_reply TEXT CHECK (auto_reply IN ('full','holding','held'));

-- 0028 Closed-day reply timing (21 Nov 2026): holding replies are scheduled as late as possible inside Amazon's 48-hour window,
-- only between 09:00 and 17:00, and only when staff would not be back in time.
ALTER TABLE public.auto_replies ADD COLUMN IF NOT EXISTS send_after TIMESTAMPTZ;
ALTER TABLE public.auto_replies ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
ALTER TABLE public.auto_replies DROP CONSTRAINT IF EXISTS auto_replies_kind_check;
ALTER TABLE public.auto_replies ADD CONSTRAINT auto_replies_kind_check
  CHECK (kind IN ('pending','full','holding','scheduled','staff','superseded','skipped','failed'));
CREATE INDEX IF NOT EXISTS idx_auto_replies_scheduled ON public.auto_replies (send_after) WHERE kind = 'scheduled';

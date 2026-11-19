-- 0025: AI Overview on the case page. Generated only when staff open the panel; kept until a new message arrives
-- (source_marker = last message id + count), so reopening it is instant and costs nothing. Safe to run more than once.
CREATE TABLE IF NOT EXISTS public.case_overviews (
  case_id       INTEGER PRIMARY KEY REFERENCES public.cases(id) ON DELETE CASCADE,
  source_marker TEXT NOT NULL,
  data          JSONB NOT NULL,
  model         TEXT,
  created_by    INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

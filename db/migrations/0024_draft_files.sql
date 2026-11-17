-- 0024: Files attached to a reply are kept on the server until the reply is sent.
-- Before this, attached files lived only in the agent's open browser tab, so an approval round-trip, a reload or a
-- regenerated draft silently dropped them and the reply went out without the file (RIQ-1343, invoice INV-062798).
-- draft_id NULL = attached to the case before a draft existed; the next draft picks it up. Rows are deleted once sent
-- (the sent copy lives in Gmail and is recorded in public.attachments). Safe to run more than once.
CREATE TABLE IF NOT EXISTS public.draft_files (
  id          SERIAL PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  draft_id    INTEGER REFERENCES public.drafts(id) ON DELETE SET NULL,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  base64      TEXT NOT NULL,
  created_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_draft_files_case ON public.draft_files(case_id);
CREATE INDEX IF NOT EXISTS idx_draft_files_draft ON public.draft_files(draft_id);

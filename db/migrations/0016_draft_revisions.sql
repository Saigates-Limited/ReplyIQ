-- 0016: "Request changes" on a draft.
-- The agent writes what they want changed; the model rewrites; the old draft is marked discarded and the new one
-- records which draft it replaced and the exact instruction given. Nothing is deleted (drafts stay append-only).
-- Optional: the app detects these columns and works without them (the audit trail is just not kept).

ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS revision_of    INTEGER REFERENCES public.drafts(id) ON DELETE SET NULL;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS agent_guidance TEXT;
CREATE INDEX IF NOT EXISTS idx_drafts_revision_of ON public.drafts (revision_of);

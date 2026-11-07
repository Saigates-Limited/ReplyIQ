-- 0019: Explicit approval flow for customer replies.
-- draft → (agent) pending_approval → (manager) approved → sent.   Managers may approve directly, but NOTHING is sent
-- without a recorded approval, and editing after approval always drops back to draft.
-- The app works without these columns (status alone drives the flow); they add the audit trail + rejection reason.

ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS approval_requested_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS approval_note         TEXT;      -- what the agent said when asking
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS rejected_by           INTEGER REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS rejected_at           TIMESTAMPTZ;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS rejection_reason      TEXT;
CREATE INDEX IF NOT EXISTS idx_drafts_pending ON public.drafts (status) WHERE status = 'pending_approval';

SELECT column_name FROM information_schema.columns WHERE table_name = 'drafts' AND column_name IN ('approval_requested_by','rejection_reason') ORDER BY 1;

-- 0020: "Staff can send routine replies" (Settings, default ON).
-- An active agent may approve and send any draft (their own, a colleague's, or one created by the system) in one step, but only when the server confirms at send time that the guardrail
-- result is PASS with no warnings, needs_manager is false, and the case has no open A-to-Z, no open chargeback and no battery_flag.
-- These columns are the audit trail. WITHOUT them the app keeps staff sending OFF (fail closed): a send that could not be recorded is not allowed.
-- Who sent is already in sent_recorded_by / sent_recorded_at; approved_by is the sender for these replies.

ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS sent_without_manager_approval BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS routine_check JSONB;   -- what the server verified at send time (flags, findings count, timestamp)
CREATE INDEX IF NOT EXISTS idx_drafts_staff_sent ON public.drafts (sent_recorded_at DESC) WHERE sent_without_manager_approval;

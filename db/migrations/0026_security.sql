-- 0026 Security controls for the Amazon SP-API Tax Invoicing (restricted) role review, 20 Nov 2026.
-- Passwords: 12+ chars with upper/lower/number/special, changed every 365 days. MFA (authenticator app) for every user.
-- security_log: logins, failures, MFA, password changes, buyer-address lookups. 30-day buyer data clean-up marker.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_must_change BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS totp_secret_enc      TEXT;          -- AES-256-GCM (TOKEN_ENC_KEY)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS totp_enabled_at      TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS totp_last_step       BIGINT;        -- each code works once
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS failed_logins        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS locked_until         TIMESTAMPTZ;

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'full';
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_stage_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_stage_check CHECK (stage IN ('full','mfa_verify','mfa_setup','password_change'));
-- Everyone signs in again so every account goes through MFA setup.
DELETE FROM public.sessions;

CREATE TABLE IF NOT EXISTS public.security_log (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  event    TEXT NOT NULL,
  user_id  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  email    TEXT,
  ip       TEXT,
  detail   JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_security_log_at    ON public.security_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_security_log_event ON public.security_log (event, at DESC);
-- The log is append-only: no edits, no deletes (refuse_* functions come from 0011/0012).
DROP TRIGGER IF EXISTS trg_security_log_no_update ON public.security_log;
CREATE TRIGGER trg_security_log_no_update BEFORE UPDATE ON public.security_log FOR EACH ROW EXECUTE FUNCTION public.refuse_update();
DROP TRIGGER IF EXISTS trg_security_log_no_delete ON public.security_log;
CREATE TRIGGER trg_security_log_no_delete BEFORE DELETE ON public.security_log FOR EACH ROW EXECUTE FUNCTION public.refuse_delete();

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS pii_purged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_cases_pii_due ON public.cases (last_customer_message_at) WHERE pii_purged_at IS NULL;

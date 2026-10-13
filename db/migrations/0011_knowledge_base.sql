-- 0011 — Knowledge base: extra rules / facts / phrasing examples that are appended to the AI system prompt
-- AFTER reply_instructions.md. The policy file itself is not changed by this feature and its "Never" list
-- always wins (the server guardrails are unchanged). Additive; safe to re-run.
CREATE TABLE IF NOT EXISTS public.kb_rules (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'rule' CHECK (kind IN ('rule','fact','example')),
  category     TEXT NOT NULL DEFAULT 'general',
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  rule_text    TEXT NOT NULL CHECK (length(rule_text) BETWEEN 10 AND 1500),
  modes        TEXT NOT NULL DEFAULT 'all' CHECK (modes IN ('all','customer','amazon')),   -- which draft modes see it
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','rejected','retired')),
  sort_order   INTEGER NOT NULL DEFAULT 100,
  created_by   INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  approved_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at  TIMESTAMPTZ,
  retired_at   TIMESTAMPTZ,
  review_note  TEXT,                                   -- manager's reason when rejecting / retiring
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_rules_status ON public.kb_rules(status, sort_order, id);

-- Record which knowledge-base rules were in force when each draft was generated (audit trail).
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS kb_rule_ids INTEGER[];

-- updated_at trigger (reuses the helper created in 0008 if present; otherwise creates it)
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_kb_rules_updated ON public.kb_rules;
CREATE TRIGGER trg_kb_rules_updated BEFORE UPDATE ON public.kb_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- No DELETE on kb_rules: retire instead (same archive-not-delete principle as cases).
CREATE OR REPLACE FUNCTION public.refuse_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Deleting % rows is disabled — retire/archive instead', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_kb_rules_no_delete ON public.kb_rules;
CREATE TRIGGER trg_kb_rules_no_delete BEFORE DELETE ON public.kb_rules FOR EACH ROW EXECUTE FUNCTION public.refuse_delete();

-- Verification
SELECT 'table' AS kind, 'kb_rules' AS name WHERE to_regclass('public.kb_rules') IS NOT NULL
UNION ALL
SELECT 'column', column_name FROM information_schema.columns WHERE table_name = 'drafts' AND column_name = 'kb_rule_ids'
UNION ALL
SELECT 'trigger', tgname FROM pg_trigger WHERE tgrelid = 'public.kb_rules'::regclass AND NOT tgisinternal;

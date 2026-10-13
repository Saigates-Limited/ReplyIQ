-- 0012 — Custom system prompt (manager-edited persona / company background / house style).
-- Sits AFTER reply_instructions.md and BEFORE knowledge-base rules in the system message.
-- Append-only version history: every save is a new row; "roll back" = a new version with the old text.
-- The newest version is the one in force. An empty body means "no custom prompt". Additive; safe to re-run.
CREATE TABLE IF NOT EXISTS public.system_prompt_versions (
  version     SERIAL PRIMARY KEY,
  body        TEXT NOT NULL CHECK (length(body) <= 4000),
  note        TEXT,                                   -- why it changed / "Rolled back to v3"
  restored_from INTEGER,                              -- set when this version is a roll-back
  created_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Record which prompt version was in force when each draft was generated (audit, like kb_rule_ids).
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS system_prompt_version INTEGER;

-- No DELETE / UPDATE: history is immutable (reuses refuse_delete() from 0011).
CREATE OR REPLACE FUNCTION public.refuse_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Deleting % rows is disabled — retire/archive instead', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION public.refuse_update() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Updating % rows is disabled — save a new version instead', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_spv_no_delete ON public.system_prompt_versions;
CREATE TRIGGER trg_spv_no_delete BEFORE DELETE ON public.system_prompt_versions FOR EACH ROW EXECUTE FUNCTION public.refuse_delete();
DROP TRIGGER IF EXISTS trg_spv_no_update ON public.system_prompt_versions;
CREATE TRIGGER trg_spv_no_update BEFORE UPDATE ON public.system_prompt_versions FOR EACH ROW EXECUTE FUNCTION public.refuse_update();

-- Verification
SELECT 'table' AS kind, 'system_prompt_versions' AS name WHERE to_regclass('public.system_prompt_versions') IS NOT NULL
UNION ALL
SELECT 'column', column_name FROM information_schema.columns WHERE table_name = 'drafts' AND column_name = 'system_prompt_version'
UNION ALL
SELECT 'trigger', tgname FROM pg_trigger WHERE tgrelid = 'public.system_prompt_versions'::regclass AND NOT tgisinternal;

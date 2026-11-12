-- 0021: (1) repair reply_templates on databases where the table existed before 0014 (so 0014's CREATE TABLE IF NOT EXISTS skipped it),
--       (2) retire the knowledge-base rule that told the model to use "statutory rights" wording,
--       (3) list anything else that still contains that wording (read-only, nothing is edited or deleted).
-- Safe to re-run. Nothing is deleted; no template text is changed.

-- ── 1. reply_templates columns. created_by / updated_by are the ones the app reads (the /templates 500: "column t.updated_by does not exist").
--       The rest are defensive: each is a no-op if the column is already there, and each has a default so existing rows are fine.
ALTER TABLE public.reply_templates ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.reply_templates ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.reply_templates ADD COLUMN IF NOT EXISTS category   TEXT        NOT NULL DEFAULT 'general';
ALTER TABLE public.reply_templates ADD COLUMN IF NOT EXISTS status     TEXT        NOT NULL DEFAULT 'active';
ALTER TABLE public.reply_templates ADD COLUMN IF NOT EXISTS sort_order INTEGER     NOT NULL DEFAULT 100;
ALTER TABLE public.reply_templates ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.reply_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── 2. Retire the old knowledge-base rule (kept for the audit trail, never deleted). Only matches the seed rule by its title.
DO $$
BEGIN
  IF to_regclass('public.kb_rules') IS NOT NULL THEN
    UPDATE public.kb_rules
       SET status = 'retired', retired_at = now(),
           review_note = 'Retired: Saigates does not use statutory / consumer / legal rights wording in replies'
     WHERE title = 'Statutory wording only when needed' AND status IN ('active', 'draft');
  END IF;
END $$;

-- ── 3. Review list: templates and knowledge-base rules that still contain the wording. Edit them on /templates and /knowledge-base
--       (the app now refuses to save this wording, and the draft checker fails any draft that contains it).
SELECT 'template' AS kind, t.slug AS ref, t.title, t.status
  FROM public.reply_templates t
 WHERE t.body ~* '(statutory|consumer rights?|legal rights?)'
UNION ALL
SELECT 'kb_rule', k.id::text, k.title, k.status
  FROM public.kb_rules k
 WHERE k.status IN ('active', 'draft') AND k.rule_text ~* '(statutory|consumer rights?|legal rights?)'
 ORDER BY 1, 2;

-- 0029 Shopify (Saisales.co.uk) integration (23 Nov 2026).
--   • cases.channel: 'amazon' (everything so far) or 'shopify' (Saisales.co.uk customers who email us).
--   • cases.shopify_order_gid / shopify_order: the matched Shopify order and a NON-PII summary of it (items, payment,
--     fulfilment, tracking, refunds, returns). The summary is what the AI sees; names, emails and addresses are never in it.
--   • gmail_connection.saisales_mail: also read Saisales customer mail (info@ / support@saisales.co.uk, Shopify contact form)
--     in this mailbox. Replies to those customers go out from the same mailbox as the Saisales address (Gmail "Send mail as").
--   • shopify_actions: audit of every refund / return / label done on Shopify from ReplyIQ (who, what, amount, result).
-- Additive; safe to re-run.

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'amazon';
ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_channel_check;
ALTER TABLE public.cases ADD CONSTRAINT cases_channel_check CHECK (channel IN ('amazon', 'shopify'));
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS shopify_order_gid TEXT;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS shopify_order JSONB;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS shopify_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_cases_channel ON public.cases (channel);
CREATE INDEX IF NOT EXISTS idx_cases_shopify_order ON public.cases (shopify_order_gid) WHERE shopify_order_gid IS NOT NULL;

ALTER TABLE public.gmail_connection ADD COLUMN IF NOT EXISTS saisales_mail BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.shopify_actions (
  id            BIGSERIAL PRIMARY KEY,
  case_id       INTEGER REFERENCES public.cases(id) ON DELETE SET NULL,
  order_gid     TEXT NOT NULL,
  order_name    TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('refund', 'return_open', 'return_label', 'return_process', 'return_cancel')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  amount        NUMERIC(10, 2),
  currency      TEXT,
  reason        TEXT,
  detail        JSONB,                 -- request summary + Shopify ids returned (refund id, return id, reverse delivery id)
  error         TEXT,
  created_by    INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shopify_actions_case ON public.shopify_actions (case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_actions_order ON public.shopify_actions (order_gid, created_at DESC);

-- Verification
SELECT 'column' AS kind, table_name || '.' || column_name AS name FROM information_schema.columns
 WHERE (table_name = 'cases' AND column_name IN ('channel', 'shopify_order_gid', 'shopify_order', 'shopify_synced_at'))
    OR (table_name = 'gmail_connection' AND column_name = 'saisales_mail')
UNION ALL
SELECT 'table', table_name FROM information_schema.tables WHERE table_name = 'shopify_actions'
ORDER BY 1, 2;

-- 0010 — SP-API order cache, review-request log, delivery-date provenance. Additive; safe to re-run.
CREATE TABLE IF NOT EXISTS public.amazon_orders (
  order_id    TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,            -- OrderSummary (no buyer/recipient data is ever requested)
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.review_requests (
  id            SERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE,    -- once per order, enforced here and by Amazon (403 on repeat)
  case_id       INTEGER REFERENCES public.cases(id) ON DELETE SET NULL,
  requested_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  result        TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | ineligible | already_requested | error
  detail        TEXT,
  completed_at  TIMESTAMPTZ
);
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS delivery_date_source TEXT;   -- staff | amazon_actual | amazon_estimated
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS spapi_synced_at TIMESTAMPTZ;
SELECT 'table' AS kind, t AS name FROM unnest(ARRAY['amazon_orders','review_requests']) t WHERE to_regclass('public.' || t) IS NOT NULL
UNION ALL
SELECT 'column', column_name FROM information_schema.columns WHERE table_name = 'cases' AND column_name IN ('delivery_date_source','spapi_synced_at');

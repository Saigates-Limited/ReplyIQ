-- 0017: Physical returns (replaces the Google Sheet) + "Refund initiated" events with daily reconciliation.
-- Additive only. Safe to re-run. Nothing is dropped except CHECK constraints that are recreated wider.

-- ───────────────────────── PART 1 · PHYSICAL RETURNS ─────────────────────────

-- Lookups (drop-downs; managers can add rows from the UI)
CREATE TABLE IF NOT EXISTS public.return_supplier_codes (
  code        TEXT PRIMARY KEY,
  label       TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.return_supplier_codes (code) VALUES
  ('SW001'),('SLP001'),('GP001'),('LW001'),('SS001'),('UT001'),('TD001'),('RT001')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.return_skus (
  sku         TEXT PRIMARY KEY,                 -- canonical SKU, e.g. I13-128-MDT-A
  model       TEXT,                             -- human label, e.g. iPhone 13 128GB Midnight (A)
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per returned parcel / order. Phones inside it are return_items.
CREATE TABLE IF NOT EXISTS public.returns (
  id                 SERIAL PRIMARY KEY,
  case_id            INTEGER REFERENCES public.cases(id) ON DELETE SET NULL,
  event_id           INTEGER REFERENCES public.amazon_events(id) ON DELETE SET NULL,   -- the return_request notice
  order_id           TEXT NOT NULL,
  order_date         DATE,
  delivery_date      DATE,                      -- warranty clock runs from this
  marketplace        TEXT,                      -- e.g. Amazon.co.uk
  sku                TEXT,                      -- from return_skus (not enforced by FK so imports can hold an unmatched value under review)
  asin               TEXT,
  quantity           INTEGER NOT NULL DEFAULT 1,
  amazon_reason      TEXT,                      -- Amazon return reason code/text
  customer_comment   TEXT,
  status             TEXT NOT NULL DEFAULT 'expected'
                     CHECK (status IN ('expected','received','inspected','outcome_agreed','closed')),
  -- receiving
  return_tracking    TEXT,
  received_at        TIMESTAMPTZ,
  received_by        INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  -- stock / notes
  notes              TEXT,
  -- repeat-return linking
  repeat_of          INTEGER REFERENCES public.returns(id) ON DELETE SET NULL,
  repeat_reason      TEXT,                      -- 'order' | 'imei'
  -- legacy import (only when no case exists for the order; otherwise the case holds the customer data)
  legacy_customer_name TEXT,
  import_batch_id    INTEGER,
  import_row         INTEGER,
  review_flags       JSONB NOT NULL DEFAULT '[]',   -- things a human must check after import
  -- closing
  closed_at          TIMESTAMPTZ,
  closed_by          INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_by         INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_returns_order    ON public.returns (order_id);
CREATE INDEX IF NOT EXISTS idx_returns_status   ON public.returns (status, received_at);
CREATE INDEX IF NOT EXISTS idx_returns_case     ON public.returns (case_id);
CREATE INDEX IF NOT EXISTS idx_returns_event    ON public.returns (event_id);
CREATE INDEX IF NOT EXISTS idx_returns_tracking ON public.returns (return_tracking);

-- One row per phone in the parcel.
CREATE TABLE IF NOT EXISTS public.return_items (
  id                   SERIAL PRIMARY KEY,
  return_id            INTEGER NOT NULL REFERENCES public.returns(id) ON DELETE CASCADE,
  item_no              INTEGER NOT NULL DEFAULT 1,
  -- receiving
  imei                 TEXT CHECK (imei IS NULL OR imei ~ '^[0-9]{15}$'),   -- TEXT, never numeric; Luhn checked in the app
  imei_matches         TEXT CHECK (imei_matches IN ('yes','no','unknown')) DEFAULT 'unknown',
  -- inspection
  reason_category      TEXT CHECK (reason_category IN ('faulty','cosmetic','change_of_mind','returned_to_sender','wrong_item')),
  cable                TEXT CHECK (cable IN ('returned','not_returned','damaged','not_applicable')),
  frp_lock             BOOLEAN,
  lock_deadline_at     TIMESTAMPTZ,              -- FRP = yes → customer has 2 days to unlock
  battery_health       INTEGER CHECK (battery_health IS NULL OR (battery_health BETWEEN 0 AND 100)),
  fault_found          TEXT,
  supplier_code        TEXT REFERENCES public.return_supplier_codes(code) ON UPDATE CASCADE ON DELETE SET NULL,
  inspected_at         TIMESTAMPTZ,
  inspected_by         INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  -- outcome
  outcome              TEXT CHECK (outcome IN ('refund','partial_refund','replacement','repair','resend')),
  refund_amount        NUMERIC(10,2),
  replacement_imei     TEXT CHECK (replacement_imei IS NULL OR replacement_imei ~ '^[0-9]{15}$'),
  replacement_sent_on  DATE,
  repair_completed_on  DATE,
  cms_ticket           TEXT,
  compensation_ref     TEXT,
  outcome_at           TIMESTAMPTZ,
  outcome_by           INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  -- stock
  stock_disposition    TEXT CHECK (stock_disposition IN ('back_to_stock','repair','return_to_supplier','write_off')),
  -- governance
  needs_manager        BOOLEAN NOT NULL DEFAULT FALSE,
  manager_reason       TEXT,
  manager_cleared_by   INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  manager_cleared_at   TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (return_id, item_no)
);
CREATE INDEX IF NOT EXISTS idx_return_items_imei   ON public.return_items (imei);
CREATE INDEX IF NOT EXISTS idx_return_items_return ON public.return_items (return_id);

-- Photos: today a link to a customer attachment already on the case; r2_key filled when direct upload is enabled.
CREATE TABLE IF NOT EXISTS public.return_photos (
  id              SERIAL PRIMARY KEY,
  return_item_id  INTEGER NOT NULL REFERENCES public.return_items(id) ON DELETE CASCADE,
  attachment_id   INTEGER REFERENCES public.attachments(id) ON DELETE SET NULL,
  filename        TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,
  r2_key          TEXT,
  uploaded_by     INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time Google Sheet import: every batch is recorded with its review list.
CREATE TABLE IF NOT EXISTS public.return_import_batches (
  id            SERIAL PRIMARY KEY,
  filename      TEXT,
  mode          TEXT NOT NULL CHECK (mode IN ('dry_run','committed')),
  row_count     INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  review_count  INTEGER NOT NULL DEFAULT 0,
  review        JSONB NOT NULL DEFAULT '[]',      -- [{row, order_id, field, value, reason}]
  created_by    INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.returns DROP CONSTRAINT IF EXISTS returns_import_batch_fk;
ALTER TABLE public.returns ADD CONSTRAINT returns_import_batch_fk
  FOREIGN KEY (import_batch_id) REFERENCES public.return_import_batches(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS trg_returns_updated ON public.returns;
CREATE TRIGGER trg_returns_updated BEFORE UPDATE ON public.returns FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_return_items_updated ON public.return_items;
CREATE TRIGGER trg_return_items_updated BEFORE UPDATE ON public.return_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ───────────────────── PART 2 · REFUND INITIATED + RECONCILIATION ─────────────────────

-- New event kind
ALTER TABLE public.amazon_events DROP CONSTRAINT IF EXISTS amazon_events_kind_check;
ALTER TABLE public.amazon_events ADD CONSTRAINT amazon_events_kind_check
  CHECK (kind IN ('atoz_claim','atoz_info_request','atoz_decision','return_request','chargeback','refund_initiated'));

-- Status per kind (refund_initiated: open → reconciled OK, or alert → chasing → claim_filed → recovered | written_off)
ALTER TABLE public.amazon_events DROP CONSTRAINT IF EXISTS amazon_events_status_check;
ALTER TABLE public.amazon_events ADD CONSTRAINT amazon_events_status_check CHECK (
  (kind IN ('atoz_claim','atoz_info_request','atoz_decision','chargeback')
     AND status IN ('open','info_requested','response_sent','won','lost','closed'))
  OR
  (kind = 'return_request'
     AND status IN ('requested','received','inspected','refunded','closed'))
  OR
  (kind = 'refund_initiated'
     AND status IN ('open','ok','alert','chasing','claim_filed','recovered','written_off'))
);

-- Refund-specific columns (NULL for other kinds)
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS refund_reason      TEXT;        -- 'Buyer Cancelled' | 'Customer Return' | anything else (flagged)
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS spc_ref            TEXT;        -- SPC-EUAmazon-…
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS refund_items       JSONB;       -- [{name, asin, sku, quantity, item_refund, delivery_refund, reason}]
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS is_partial         BOOLEAN;     -- item refund < order item price
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS needs_manager      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS return_id          INTEGER REFERENCES public.returns(id) ON DELETE SET NULL;
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS reconciled_at      TIMESTAMPTZ;
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS reconcile_result   TEXT;        -- ok_cancelled_before_dispatch | ok_return_received | alert_shipped_not_back | alert_not_received | alert_review_reason
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS alert_notes        TEXT;
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS alert_updated_by   INTEGER REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.amazon_events ADD COLUMN IF NOT EXISTS alert_updated_at   TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_events_refund_open ON public.amazon_events (kind, status) WHERE kind = 'refund_initiated';
CREATE INDEX IF NOT EXISTS idx_events_spc ON public.amazon_events (spc_ref) WHERE spc_ref IS NOT NULL;

-- Daily refund check + 90-day back-check are recorded in the existing sync_runs (trigger = 'refund_check' / 'refund_backcheck')
ALTER TABLE public.sync_runs ADD COLUMN IF NOT EXISTS summary JSONB;

-- Resumable back-check cursor lives in app_settings (key 'refund_backcheck'); table exists from 0015.
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 0029 Carrier KPIs (23 Nov 2026): order ID on every carrier case, an owner per case, and the timestamps the
-- KPI report needs (customer reported → investigation raised; carrier said claim → claim lodged; carrier asked for
-- information → sent; order ID added; carrier news → customer told). Additive; safe to re-run.

-- When the customer first told us about the delivery problem (start of the "raise an investigation" clock)
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ;
-- Who is responsible for the case (KPIs are reported per owner). New cases get the default owner from Carrier settings.
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES public.users(id) ON DELETE SET NULL;

-- Order ID task. Parcels already on the desk when this runs get 2 working days (the one-off backlog); new parcels 1.
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS no_order BOOLEAN NOT NULL DEFAULT FALSE;       -- staff confirmed there is no customer order (postage refund, inbound parcel…)
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS order_id_set_at TIMESTAMPTZ;
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS order_id_set_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS order_id_window_days SMALLINT NOT NULL DEFAULT 2;
ALTER TABLE public.carrier_cases ALTER COLUMN order_id_window_days SET DEFAULT 1;
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS order_id_requested_at TIMESTAMPTZ;
UPDATE public.carrier_cases SET order_id_requested_at = created_at, order_id_set_at = COALESCE(order_id_set_at, created_at)
  WHERE order_id_requested_at IS NULL AND order_id IS NOT NULL;          -- already had one: nothing to do
UPDATE public.carrier_cases SET order_id_requested_at = now()
  WHERE order_id_requested_at IS NULL AND order_id IS NULL;              -- backlog: the 2-working-day clock starts now
ALTER TABLE public.carrier_cases ALTER COLUMN order_id_requested_at SET DEFAULT now();

-- Carrier news for the customer: when it became due and when staff told the customer
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS customer_update_due_at TIMESTAMPTZ;
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS customer_told_at TIMESTAMPTZ;

-- Backfill: customer cases already flagged with a delivery problem before the investigation went out
UPDATE public.carrier_cases cc SET reported_at = c.carrier_issue_at
  FROM public.cases c
  WHERE cc.case_id = c.id AND cc.reported_at IS NULL AND c.carrier_issue_at IS NOT NULL
    AND c.carrier_issue_at <= COALESCE(cc.raised_at, now());

-- Keep the KPI timestamps right whichever code path changes the row
CREATE OR REPLACE FUNCTION public.carrier_cases_kpi_stamps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.order_id IS NOT NULL OR NEW.no_order THEN NEW.order_id_set_at := COALESCE(NEW.order_id_set_at, now()); END IF;
    IF NEW.customer_update_due THEN NEW.customer_update_due_at := COALESCE(NEW.customer_update_due_at, now()); END IF;
    RETURN NEW;
  END IF;
  IF (NEW.order_id IS NOT NULL OR NEW.no_order) AND OLD.order_id IS NULL AND NOT OLD.no_order THEN
    NEW.order_id_set_at := now();
  ELSIF NEW.order_id IS NULL AND NOT NEW.no_order THEN
    NEW.order_id_set_at := NULL;                                          -- cleared again: back on the task list
  END IF;
  IF NEW.customer_update_due AND NOT OLD.customer_update_due THEN
    NEW.customer_update_due_at := now(); NEW.customer_told_at := NULL;
  ELSIF OLD.customer_update_due AND NOT NEW.customer_update_due THEN
    NEW.customer_told_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_carrier_cases_kpi_stamps ON public.carrier_cases;
CREATE TRIGGER trg_carrier_cases_kpi_stamps BEFORE INSERT OR UPDATE ON public.carrier_cases FOR EACH ROW EXECUTE FUNCTION public.carrier_cases_kpi_stamps();

CREATE INDEX IF NOT EXISTS idx_carrier_cases_missing_order ON public.carrier_cases (order_id_requested_at) WHERE order_id IS NULL AND NOT no_order;
CREATE INDEX IF NOT EXISTS idx_carrier_messages_kind ON public.carrier_messages (kind, sent_at);

-- KPI settings: target in working days per step, and the day KPIs start counting (earlier activity is not scored)
INSERT INTO public.app_settings (key, value) VALUES
  ('carrier_kpi', jsonb_build_object('target_days', 1, 'start', to_char(now() AT TIME ZONE 'Europe/London', 'YYYY-MM-DD')))
  ON CONFLICT (key) DO NOTHING;

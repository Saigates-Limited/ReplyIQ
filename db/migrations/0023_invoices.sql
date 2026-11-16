-- 0023: Invoice generator (moved in from the stand-alone Amazon Invoice Dashboard).
-- Invoice numbers are the real Zoho Inventory invoice numbers, typed in by staff (no auto-sequence).
-- Self-contained (two tables, no foreign keys except the optional case/user links) so it can move to Device IQ later.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.invoice_settings (
  id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name       TEXT NOT NULL DEFAULT 'Saigates Limited',
  address_line1      TEXT NOT NULL DEFAULT '',
  address_line2      TEXT NOT NULL DEFAULT '',
  city               TEXT NOT NULL DEFAULT '',
  postcode           TEXT NOT NULL DEFAULT '',
  country            TEXT NOT NULL DEFAULT 'United Kingdom',
  vat_number         TEXT NOT NULL DEFAULT '',
  company_number     TEXT NOT NULL DEFAULT '',
  email              TEXT NOT NULL DEFAULT '',
  phone              TEXT NOT NULL DEFAULT '',
  logo_data_url      TEXT NOT NULL DEFAULT '',
  accent_color       TEXT NOT NULL DEFAULT '#111827',
  margin_scheme_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  margin_scheme_note TEXT NOT NULL DEFAULT 'This is a second-hand good sold under the VAT Margin Scheme (Margin Scheme - Second-Hand Goods), in accordance with VAT Notice 718 / Section 50A VAT Act 1994. VAT is accounted for on the margin and is not separately shown or recoverable on this invoice.',
  footer_note        TEXT NOT NULL DEFAULT 'Thank you for your order.',
  terms_and_conditions TEXT NOT NULL DEFAULT '1) Customer warrants to Saigates Limited that all user data, including but not restricted to images contained on any type of data storage within all of the devices on this invoice, will be erased before the onward sale by Customer if not already done so.
2) Any stock discrepancy should be reported within 30 days of receipt. Saigates Limited will not be liable to consider any claims after this period.
3) Saigates Limited is happy to exchange any device within a 30-day period unless other terms are agreed upon beforehand. Any devices reported as faulty, etc., after this period will not be returned or exchanged.',
  updated_by         INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.invoice_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.invoices (
  id               SERIAL PRIMARY KEY,
  invoice_number   TEXT NOT NULL UNIQUE,            -- Zoho Inventory invoice number
  order_id         TEXT NOT NULL DEFAULT '',
  seller_order_id  TEXT NOT NULL DEFAULT '',
  purchase_date    TEXT NOT NULL DEFAULT '',
  ship_date        TEXT NOT NULL DEFAULT '',
  invoice_date     TEXT NOT NULL DEFAULT '',
  sales_channel    TEXT NOT NULL DEFAULT '',
  buyer_name       TEXT NOT NULL DEFAULT '',
  buyer_address    TEXT NOT NULL DEFAULT '',        -- one line per address line
  currency         TEXT NOT NULL DEFAULT 'GBP',
  items            JSONB NOT NULL DEFAULT '[]',     -- [{name, asin, sku, condition, imei, quantity, unitPrice, total}]
  shipping         NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0,
  total            NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes            TEXT NOT NULL DEFAULT '',
  margin_scheme_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  settings_snapshot JSONB NOT NULL DEFAULT '{}',    -- branding/terms as printed, so a re-download is identical
  raw_paste        TEXT NOT NULL DEFAULT '',
  case_id          INTEGER REFERENCES public.cases(id) ON DELETE SET NULL,
  created_by       INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON public.invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_case ON public.invoices(case_id);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON public.invoices(created_at DESC);

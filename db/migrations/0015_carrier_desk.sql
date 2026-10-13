-- 0015 — Carrier desk: carrier investigations and claims (Royal Mail, DPD, FedEx, Evri), linked to customer cases.
-- One row per PARCEL (carrier + tracking number), however many emails, threads or carrier case references it collects.
-- Additive; safe to re-run. Nothing here sends email: carrier emails go out only through POST /api/carrier/drafts/:id/send,
-- after a member of staff approves the exact text.

-- Mailboxes that receive carrier mail (e.g. saigateslimited@gmail.com, which gets copies of ecom@saigates.com)
ALTER TABLE public.gmail_connection ADD COLUMN IF NOT EXISTS carrier_mail BOOLEAN NOT NULL DEFAULT FALSE;

-- Issue the customer described in their latest message (set by the sync; staff can clear it)
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS carrier_issue TEXT;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS carrier_issue_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.carrier_cases (
  id                 SERIAL PRIMARY KEY,
  case_id            INTEGER REFERENCES public.cases(id) ON DELETE SET NULL,   -- customer case (NULL for carrier-only cases)
  carrier            TEXT NOT NULL CHECK (carrier IN ('royal_mail','dpd','fedex','evri','other')),
  tracking           TEXT,                                                   -- upper case, no spaces
  order_id           TEXT,                                                   -- Amazon 3-7-7, Temu PO-…, eBay, etc.
  issue              TEXT NOT NULL DEFAULT 'lost' CHECK (issue IN ('lost','delivered_not_received','empty_parcel','damaged','wrong_item','pod_request','return_to_sender','postage_refund','other')),
  status             TEXT NOT NULL DEFAULT 'to_raise' CHECK (status IN ('to_raise','awaiting_carrier','action_needed','claim_form_needed','claim_submitted','escalated','paid','partially_paid','rejected','closed')),
  product            TEXT,
  service            TEXT,                                                   -- e.g. Tracked 24, Special Delivery, DPD Next Day
  value              NUMERIC(10,2),
  posted_on          DATE,
  delivered_on       DATE,                                                   -- what the carrier's tracking says, if anything
  carrier_refs       JSONB NOT NULL DEFAULT '[]',                            -- every carrier case reference seen, e.g. ["14856287"]
  claim_ref          TEXT,
  raised_at          TIMESTAMPTZ,                                            -- our first email to the carrier
  last_us_at         TIMESTAMPTZ,
  last_carrier_at    TIMESTAMPTZ,                                            -- latest carrier email that is NOT an auto-acknowledgement
  carrier_reply_type TEXT CHECK (carrier_reply_type IN ('auto_ack','replied','decision')),
  sla_due_at         TIMESTAMPTZ,                                            -- when the carrier's reply (or decision) is due
  claimed            NUMERIC(10,2),
  paid               NUMERIC(10,2),
  paid_on            DATE,
  next_action        TEXT,
  next_due           DATE,
  notes              TEXT,
  customer_update_due BOOLEAN NOT NULL DEFAULT FALSE,                      -- carrier gave news the customer has not been told yet
  gmail_thread_id    TEXT,                                                   -- latest carrier thread (replies go here)
  mailbox_id         INTEGER REFERENCES public.gmail_connection(id) ON DELETE SET NULL,
  source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('customer_message','carrier_email','import','manual')),
  created_by         INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  closed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_carrier_cases_tracking ON public.carrier_cases (carrier, tracking) WHERE tracking IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_carrier_cases_case ON public.carrier_cases (case_id);
CREATE INDEX IF NOT EXISTS idx_carrier_cases_status ON public.carrier_cases (status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_carrier_cases_refs ON public.carrier_cases USING GIN (carrier_refs);  -- carrier_refs ?| array[...]

CREATE TABLE IF NOT EXISTS public.carrier_messages (
  id               SERIAL PRIMARY KEY,
  carrier_case_id  INTEGER NOT NULL REFERENCES public.carrier_cases(id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('inbound','outbound','note')),
  kind             TEXT NOT NULL DEFAULT 'other',      -- auto_ack | holding_reply | info_request | decision_lost | decision_delivered | decision_rejected | claim_settled | escalation | investigation | chase | note | other
  from_addr        TEXT,
  to_addr          TEXT,
  subject          TEXT,
  body             TEXT NOT NULL,
  summary          TEXT,                               -- one line for the timeline (PII-free)
  extracted        JSONB NOT NULL DEFAULT '{}',        -- case refs, claim ref, amounts found
  gmail_message_id TEXT UNIQUE,
  rfc_message_id   TEXT,
  gmail_thread_id  TEXT,
  mailbox_id       INTEGER REFERENCES public.gmail_connection(id) ON DELETE SET NULL,
  sent_by          INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_carrier_messages_case ON public.carrier_messages (carrier_case_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_carrier_messages_rfc ON public.carrier_messages (rfc_message_id);

-- Emails to carriers. Same discipline as customer drafts: draft → approved by a person → sent once.
CREATE TABLE IF NOT EXISTS public.carrier_drafts (
  id                    SERIAL PRIMARY KEY,
  carrier_case_id       INTEGER NOT NULL REFERENCES public.carrier_cases(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('investigation','chase','challenge','info_reply','claim_pack','postage_refund')),
  to_address            TEXT,                          -- NULL for claim packs (pasted into the carrier's portal)
  subject               TEXT NOT NULL,
  body                  TEXT NOT NULL,
  original_body         TEXT NOT NULL,
  missing               JSONB NOT NULL DEFAULT '[]',   -- facts the template could not fill
  needs_manager         BOOLEAN NOT NULL DEFAULT FALSE,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','sent','discarded')),
  auto_created          BOOLEAN NOT NULL DEFAULT FALSE, -- prepared by the cron (e.g. chase after the SLA passed)
  created_by            INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  edited_by             INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  approved_by           INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at           TIMESTAMPTZ,
  sent_by               INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  sent_at               TIMESTAMPTZ,
  sent_gmail_message_id TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one live draft of each kind per parcel (so the cron can never stack up duplicate chases)
CREATE UNIQUE INDEX IF NOT EXISTS uq_carrier_drafts_live ON public.carrier_drafts (carrier_case_id, kind) WHERE status IN ('draft','approved','sending');

-- Small key/value settings (sender address, carrier addresses, signature)
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_carrier_cases_updated ON public.carrier_cases;
CREATE TRIGGER trg_carrier_cases_updated BEFORE UPDATE ON public.carrier_cases FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_carrier_drafts_updated ON public.carrier_drafts;
CREATE TRIGGER trg_carrier_drafts_updated BEFORE UPDATE ON public.carrier_drafts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- Carrier cases are closed, never deleted (keeps the recovery figures right)
DROP TRIGGER IF EXISTS trg_carrier_cases_no_delete ON public.carrier_cases;
CREATE TRIGGER trg_carrier_cases_no_delete BEFORE DELETE ON public.carrier_cases FOR EACH ROW EXECUTE FUNCTION public.refuse_delete();

-- (added during build) safe re-run for databases created from an earlier draft of this file
ALTER TABLE public.carrier_cases ADD COLUMN IF NOT EXISTS customer_update_due BOOLEAN NOT NULL DEFAULT FALSE;

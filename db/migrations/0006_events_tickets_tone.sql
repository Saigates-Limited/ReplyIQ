-- Step A: Amazon notices (A-to-Z, returns, chargebacks), ticket fields, tone labels.

-- ───────── Amazon events (one row per notice email) ─────────
CREATE TABLE IF NOT EXISTS amazon_events (
  id                SERIAL PRIMARY KEY,
  case_id           INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  order_id          TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('atoz_claim','atoz_info_request','atoz_decision','return_request','chargeback')),
  status            TEXT NOT NULL DEFAULT 'open',    -- atoz/chargeback: open | response_sent | won | lost ; return: requested | received | inspected | refunded | closed
  amount            NUMERIC(10,2),
  currency          TEXT DEFAULT 'GBP',
  received_at       TIMESTAMPTZ NOT NULL,            -- Gmail internalDate of the notice
  deadline_at       TIMESTAMPTZ,                     -- chargeback: +7d ; atoz_info_request: +3d ; otherwise NULL
  -- return-specific
  return_request_date DATE,
  policy_check      TEXT,
  authorisation     TEXT,
  asin              TEXT,
  sku               TEXT,
  quantity          INTEGER,
  return_reason     TEXT,
  customer_comment  TEXT,
  -- chargeback-specific
  order_date        TIMESTAMPTZ,
  item_description  TEXT,
  reply_to          TEXT,                            -- Reply-To header of the notice (checked before any send is enabled)
  -- generic
  product           TEXT,
  gmail_message_id  TEXT UNIQUE,
  gmail_thread_id   TEXT,
  raw_excerpt       TEXT,                            -- redacted excerpt for the timeline
  response_text     TEXT,                            -- what staff pasted into Seller Central / emailed
  responded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  responded_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_case ON amazon_events(case_id);
CREATE INDEX IF NOT EXISTS idx_events_kind_status ON amazon_events(kind, status);
CREATE INDEX IF NOT EXISTS idx_events_deadline ON amazon_events(deadline_at);

-- ───────── Tickets ─────────
ALTER TABLE cases ADD COLUMN IF NOT EXISTS assigned_to    INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS internal_notes TEXT;                 -- never sent to customer or OpenAI
ALTER TABLE cases ADD COLUMN IF NOT EXISTS tone           TEXT CHECK (tone IN ('angry','dispute','frustrated','worried','neutral','happy'));
ALTER TABLE cases ADD COLUMN IF NOT EXISTS chargeback_open BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS battery_flag    BOOLEAN NOT NULL DEFAULT FALSE; -- heat/overheating seen in message or return reason

-- ───────── Tone on messages ─────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tone           TEXT CHECK (tone IN ('angry','dispute','frustrated','worried','neutral','happy'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tone_source    TEXT;              -- ai | staff
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tone_model     TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind           TEXT NOT NULL DEFAULT 'message'; -- message | seller_central_copy | event
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_id       INTEGER REFERENCES amazon_events(id) ON DELETE CASCADE;

-- Case source may now be an Amazon notice with no customer message yet
-- (source values: manual | gmail | amazon_notice)

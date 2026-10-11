-- Gmail integration: connected mailbox, message identifiers for threading, sync log.

-- One connected Saigates mailbox (single row). Refresh token is encrypted with TOKEN_ENC_KEY before storage.
CREATE TABLE IF NOT EXISTS gmail_connection (
  id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email_address       TEXT NOT NULL,
  refresh_token_enc   TEXT NOT NULL,          -- AES-GCM, base64(iv || ciphertext)
  scopes              TEXT NOT NULL,
  connected_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  connected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at        TIMESTAMPTZ,
  last_sync_status    TEXT,                   -- ok | error
  last_sync_error     TEXT,
  last_sync_new_msgs  INTEGER
);

-- Pending OAuth states (CSRF protection), short-lived.
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cases    ADD COLUMN IF NOT EXISTS gmail_thread_id TEXT UNIQUE;
ALTER TABLE cases    ADD COLUMN IF NOT EXISTS customer_reply_to TEXT;          -- anonymised @marketplace.amazon.co.uk address (PII-adjacent, server only)
ALTER TABLE cases    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';  -- manual | gmail

ALTER TABLE messages ADD COLUMN IF NOT EXISTS gmail_message_id TEXT UNIQUE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS rfc_message_id   TEXT;           -- Message-ID header, for In-Reply-To / References
ALTER TABLE messages ADD COLUMN IF NOT EXISTS subject          TEXT;

ALTER TABLE drafts   ADD COLUMN IF NOT EXISTS sent_via         TEXT;           -- gmail | manual
ALTER TABLE drafts   ADD COLUMN IF NOT EXISTS sent_gmail_message_id TEXT;

CREATE TABLE IF NOT EXISTS sync_runs (
  id            SERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  trigger       TEXT NOT NULL,                -- cron | manual
  threads_seen  INTEGER DEFAULT 0,
  messages_new  INTEGER DEFAULT 0,
  cases_new     INTEGER DEFAULT 0,
  status        TEXT,                         -- ok | error
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);

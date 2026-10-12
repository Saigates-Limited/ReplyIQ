-- One case per Amazon order; several Gmail threads can belong to it. Keep the latest thread id on the case.
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_gmail_thread_id_key;
CREATE INDEX IF NOT EXISTS idx_cases_gmail_thread ON cases(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_cases_order ON cases(order_id);
-- Case reference numbering for imported cases
CREATE SEQUENCE IF NOT EXISTS case_ref_seq;
CREATE TABLE IF NOT EXISTS gmail_threads_seen (thread_id TEXT PRIMARY KEY, history_id TEXT, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());

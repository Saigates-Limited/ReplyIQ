ALTER TABLE drafts ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'customer'; -- customer | seller_central_atoz | seller_central_return | chargeback_evidence

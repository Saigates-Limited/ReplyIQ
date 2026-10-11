-- Adds the "customer accepted the quote" flag used to permit bank details in a reply.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS repair_quote_accepted BOOLEAN;

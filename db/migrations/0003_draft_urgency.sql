-- Adds the urgency flag returned by the model (per reply_instructions.md output schema).
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS urgency TEXT CHECK (urgency IN ('high','normal','low'));

-- X1 Sonar — migration 003: watchlist / risk signals
-- Apply:  sudo cat migrate-003.sql | sudo -u postgres psql -d echohound
-- Idempotent — safe to run more than once.
--
-- `signals` holds an ordered JSON array of objective on-chain tags recomputed
-- by aggregate.js every tick (e.g. ["concentrated","upgradeable"]). They are
-- facts, not verdicts. `closed_at` is stamped when a program account no longer
-- exists on-chain; such programs keep their history but drop out of ranking.

ALTER TABLE sonar.programs
  ADD COLUMN IF NOT EXISTS signals   JSONB DEFAULT '[]'::jsonb,  -- objective on-chain signal tags
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;                -- set when the program account disappears

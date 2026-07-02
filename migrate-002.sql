-- X1 Sonar — migration 002: upgrade-authority + infrastructure flags
-- Apply:  sudo cat migrate-002.sql | sudo -u postgres psql -d echohound
-- Idempotent — safe to run more than once.

ALTER TABLE sonar.programs
  ADD COLUMN IF NOT EXISTS upgrade_state    VARCHAR(16),   -- 'locked' | 'upgradeable' | NULL (unknown/not-loader)
  ADD COLUMN IF NOT EXISTS upgrade_authority VARCHAR(44),  -- authority pubkey when upgradeable
  ADD COLUMN IF NOT EXISTS infrastructure   BOOLEAN DEFAULT FALSE;

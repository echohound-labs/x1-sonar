-- X1 Sonar — Postgres schema
-- Runs inside the existing `echohound` database as its own schema,
-- so the existing `indexer` role works unchanged.
--
-- Apply:   sudo -u postgres psql -d echohound -f schema.sql
-- Verify:  sudo -u postgres psql -d echohound -c "\dt sonar.*"

CREATE SCHEMA IF NOT EXISTS sonar;

GRANT USAGE ON SCHEMA sonar TO indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA sonar
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO indexer;
ALTER DEFAULT PRIVILEGES IN SCHEMA sonar
  GRANT USAGE, SELECT ON SEQUENCES TO indexer;

-- One row per discovered program
CREATE TABLE IF NOT EXISTS sonar.programs (
    program_id          VARCHAR(44) PRIMARY KEY,
    first_seen_slot     BIGINT,
    first_seen_at       TIMESTAMPTZ,
    last_active_at      TIMESTAMPTZ,
    tx_count_24h        BIGINT DEFAULT 0,
    tx_count_7d         BIGINT DEFAULT 0,
    tx_count_all        BIGINT DEFAULT 0,
    unique_signers_24h  BIGINT DEFAULT 0,
    unique_signers_7d   BIGINT DEFAULT 0,
    success_rate_24h    REAL,
    sonar_score         REAL DEFAULT 0,
    category            VARCHAR(50) DEFAULT 'Unknown',
    name                VARCHAR(255),
    description         TEXT,
    website             VARCHAR(255),
    verified            BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_programs_score    ON sonar.programs (sonar_score DESC);
CREATE INDEX IF NOT EXISTS idx_programs_tx24     ON sonar.programs (tx_count_24h DESC);
CREATE INDEX IF NOT EXISTS idx_programs_firstseen ON sonar.programs (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_programs_category ON sonar.programs (category);

-- Raw interaction log (vote/compute-budget filtered at ingest).
-- Retention: rows older than 8 days are deleted by the aggregator
-- after being rolled up into daily_stats.
CREATE TABLE IF NOT EXISTS sonar.interactions (
    id          BIGSERIAL PRIMARY KEY,
    program_id  VARCHAR(44) NOT NULL,
    signature   VARCHAR(88) NOT NULL,
    slot        BIGINT NOT NULL,
    signer      VARCHAR(44),
    success     BOOLEAN,
    ts          TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inter_program_ts ON sonar.interactions (program_id, ts);
CREATE INDEX IF NOT EXISTS idx_inter_ts         ON sonar.interactions (ts);
CREATE INDEX IF NOT EXISTS idx_inter_slot       ON sonar.interactions (slot);

-- One tx can hit the same program via several instructions; dedupe
-- (program_id, signature) pairs at ingest so counts mean "transactions".
CREATE UNIQUE INDEX IF NOT EXISTS idx_inter_prog_sig
    ON sonar.interactions (program_id, signature);

-- Daily rollups for sparklines / history beyond the raw window
CREATE TABLE IF NOT EXISTS sonar.daily_stats (
    program_id      VARCHAR(44) NOT NULL,
    date            DATE NOT NULL,
    tx_count        BIGINT NOT NULL DEFAULT 0,
    unique_signers  BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (program_id, date)
);

-- Indexer checkpoint so restarts resume where they left off
CREATE TABLE IF NOT EXISTS sonar.checkpoint (
    id          INT PRIMARY KEY DEFAULT 1,
    last_slot   BIGINT NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    CHECK (id = 1)
);

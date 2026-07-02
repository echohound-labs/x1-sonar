-- Read-only role for the public-facing API.
-- Run:  sudo -u postgres psql -d echohound -f - < this file (or pipe via cat)
-- REPLACE THE PASSWORD before running (generate one: openssl rand -hex 24)

CREATE ROLE sonar_api LOGIN PASSWORD 'REPLACE_ME';
GRANT USAGE ON SCHEMA sonar TO sonar_api;
GRANT SELECT ON ALL TABLES IN SCHEMA sonar TO sonar_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA sonar GRANT SELECT ON TABLES TO sonar_api;

-- Verify it CANNOT write (both must fail with "permission denied"):
--   sudo -u postgres psql -d echohound -c "SET ROLE sonar_api; DELETE FROM sonar.programs;"
--   sudo -u postgres psql -d echohound -c "SET ROLE sonar_api; UPDATE sonar.programs SET sonar_score=0;"

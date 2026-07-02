// X1 Sonar — REST API (Fastify)
// Read-only by design: connects as the sonar_api role (SELECT-only).
// All queries parameterized; sort columns whitelisted — no raw SQL
// ever reaches the database from the outside.

require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const { Pool } = require('pg');

const DB_URL = process.env.API_DATABASE_URL || process.env.DATABASE_URL;
const PORT = parseInt(process.env.API_PORT || '3002', 10);

const pool = new Pool({ connectionString: DB_URL });

// Whitelisted sort keys → real columns. Anything else falls back to score.
const SORT_COLUMNS = {
  score: 'sonar_score',
  tx_24h: 'tx_count_24h',
  tx_7d: 'tx_count_7d',
  tx_all: 'tx_count_all',
  signers_24h: 'unique_signers_24h',
  signers_7d: 'unique_signers_7d',
  first_seen: 'first_seen_at',
  last_active: 'last_active_at',
};

const PROGRAM_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, no 0OIl

fastify.register(require('@fastify/cors'), { origin: true }); // public read-only API

const PROGRAM_FIELDS = `
  program_id, first_seen_slot, first_seen_at, last_active_at,
  tx_count_24h, tx_count_7d, tx_count_all,
  unique_signers_24h, unique_signers_7d,
  success_rate_24h, sonar_score, category, name, description, website, verified
`;

// GET /api/programs?sort=score&order=desc&limit=50&offset=0&category=DEX&new=true
fastify.get('/api/programs', async (req, reply) => {
  const sortCol = SORT_COLUMNS[req.query.sort] || 'sonar_score';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

  const where = [];
  const params = [];
  if (req.query.category) {
    params.push(String(req.query.category));
    where.push(`category = $${params.length}`);
  }
  if (req.query.new === 'true') {
    where.push(`first_seen_at > NOW() - INTERVAL '24 hours'`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT ${PROGRAM_FIELDS},
            (first_seen_at > NOW() - INTERVAL '24 hours') AS is_new,
            ROW_NUMBER() OVER (ORDER BY sonar_score DESC) AS rank
     FROM sonar.programs
     ${whereSql}
     ORDER BY ${sortCol} ${order} NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM sonar.programs ${whereSql}`,
    params.slice(0, params.length - 2)
  );

  return { total: cnt[0].total, limit, offset, programs: rows };
});

// GET /api/programs/:id — single program detail
fastify.get('/api/programs/:id', async (req, reply) => {
  const id = req.params.id;
  if (!PROGRAM_ID_RE.test(id)) {
    return reply.code(400).send({ error: 'invalid program id' });
  }
  const { rows } = await pool.query(
    `SELECT ${PROGRAM_FIELDS},
            (first_seen_at > NOW() - INTERVAL '24 hours') AS is_new
     FROM sonar.programs WHERE program_id = $1`,
    [id]
  );
  if (!rows.length) return reply.code(404).send({ error: 'program not found' });

  const { rows: rank } = await pool.query(
    `SELECT COUNT(*)::int + 1 AS rank FROM sonar.programs WHERE sonar_score > $1`,
    [rows[0].sonar_score]
  );
  return { ...rows[0], rank: rank[0].rank };
});

// GET /api/programs/:id/history?days=30 — daily sparkline data
fastify.get('/api/programs/:id/history', async (req, reply) => {
  const id = req.params.id;
  if (!PROGRAM_ID_RE.test(id)) {
    return reply.code(400).send({ error: 'invalid program id' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
  const { rows } = await pool.query(
    `SELECT date, tx_count, unique_signers
     FROM sonar.daily_stats
     WHERE program_id = $1 AND date > CURRENT_DATE - ($2 || ' days')::interval
     ORDER BY date ASC`,
    [id, days]
  );
  return { program_id: id, days, history: rows };
});

// GET /api/stats — global dashboard numbers
fastify.get('/api/stats', async () => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM sonar.programs)                                                  AS total_programs,
      (SELECT COUNT(*)::int FROM sonar.programs WHERE last_active_at > NOW() - INTERVAL '24 hours') AS active_24h,
      (SELECT COUNT(*)::int FROM sonar.programs WHERE first_seen_at > NOW() - INTERVAL '24 hours')  AS new_24h,
      (SELECT COALESCE(SUM(tx_count_24h), 0)::bigint FROM sonar.programs)                          AS tx_24h,
      (SELECT COALESCE(SUM(unique_signers_24h), 0)::bigint FROM sonar.programs)                    AS signers_24h
  `);
  return rows[0];
});

// GET /health — for monitoring
fastify.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});

fastify.listen({ port: PORT, host: '127.0.0.1' }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});

module.exports = { fastify, pool };

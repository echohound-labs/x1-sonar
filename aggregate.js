// X1 Sonar — aggregator
// Run-once script (invoked by systemd timer every 5 minutes):
//   1. Recompute per-program 24h/7d tx + signer counts and success rate
//   2. Compute Sonar Score (Theo's formula)
//   3. Upsert daily_stats rollups (today + yesterday, UTC)
//   4. Prune raw interactions older than RETENTION_DAYS (default 31)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '31', 10);
const RPC = process.env.X1_RPC_URL || 'http://localhost:8899';

const pool = new Pool({ connectionString: DB_URL });

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// base58 (no deps) — for decoding programdata / authority pubkeys
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// Read a program's upgrade state: 'locked' | 'upgradeable' | null.
// Returns { state, authority }. Non-upgradeable-loader programs → null state.
async function readUpgradeState(programId) {
  const acct = await rpc('getAccountInfo', [programId, { encoding: 'base64' }]);
  if (!acct || !acct.value || acct.value.owner !== UPGRADEABLE_LOADER) {
    return { state: null, authority: null };
  }
  const progBuf = Buffer.from(acct.value.data[0], 'base64');
  const programData = b58encode(progBuf.subarray(4, 36));
  const pd = await rpc('getAccountInfo', [programData, { encoding: 'base64' }]);
  if (!pd || !pd.value) return { state: null, authority: null };
  const buf = Buffer.from(pd.value.data[0], 'base64');
  // ProgramData: tag u32 + slot u64 + option u8 (byte 12) + authority 32
  const hasAuth = buf[12] === 1;
  return hasAuth
    ? { state: 'upgradeable', authority: b58encode(buf.subarray(13, 45)) }
    : { state: 'locked', authority: null };
}

// Sweep every tracked program once per run to see whether its account still
// exists on-chain. Batched via getMultipleAccounts (100/call) and paced — a
// value of null for a slot means that account is gone. Sets closed_at when a
// program disappears; clears it if the account comes back (redeploy at the same
// address). A failed batch is skipped, never fatal — closed_at is left as-is.
async function refreshClosedState() {
  const { rows } = await pool.query(`SELECT program_id, closed_at FROM sonar.programs`);
  const wasClosed = new Set(rows.filter((r) => r.closed_at).map((r) => r.program_id));
  const ids = rows.map((r) => r.program_id);
  let closed = 0, reopened = 0;

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let res;
    try {
      res = await rpc('getMultipleAccounts', [chunk, { encoding: 'base64' }]);
    } catch (e) {
      continue; // transient RPC error — leave this batch's closed_at untouched
    }
    const vals = (res && res.value) || [];
    for (let j = 0; j < chunk.length; j++) {
      const id = chunk[j];
      const exists = vals[j] != null;
      if (!exists && !wasClosed.has(id)) {
        await pool.query(
          `UPDATE sonar.programs SET closed_at = NOW() WHERE program_id = $1 AND closed_at IS NULL`, [id]);
        closed++;
      } else if (exists && wasClosed.has(id)) {
        await pool.query(
          `UPDATE sonar.programs SET closed_at = NULL WHERE program_id = $1`, [id]);
        reopened++;
      }
    }
    await sleep(120); // gentle pacing between batches — validator-safe
  }
  if (closed || reopened) {
    console.log(`  · closed-state sweep: ${closed} newly closed, ${reopened} reopened`);
  }
}

async function aggregate() {
  const client = await pool.connect();
  const t0 = Date.now();
  try {
    // 0. Ensure the derived columns exist. Added manually by the DBA (the
    //    runtime role may lack ALTER), so try/catch like backfill.js — a
    //    privileged role self-heals, everyone else no-ops. Done before BEGIN
    //    so a privilege error can't abort the aggregation transaction.
    //    `signals` (objective on-chain tags) + `closed_at` (account gone) are
    //    also part of migrate-003.sql for DBA-managed deployments.
    const ALTER_SQL = `ALTER TABLE sonar.programs
  ADD COLUMN IF NOT EXISTS tx_count_30d BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unique_signers_30d BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS signals JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`;
    try {
      await client.query(ALTER_SQL);
    } catch (e) {
      console.log(`  · runtime role can't ALTER TABLE (${e.message}). Run this as postgres:`);
      console.log(`\n${ALTER_SQL};\n`);
      console.log('  · (or apply migrate-003.sql) — continuing, assuming columns are DBA-managed.');
    }

    // 0b. Detect closed program accounts (RPC, outside the txn) BEFORE scoring
    //     and signal computation read closed_at. Non-fatal on RPC trouble.
    try {
      await refreshClosedState();
    } catch (e) {
      console.error('[sonar-aggregate] closed-state sweep skipped:', e.message);
    }

    await client.query('BEGIN');

    // 1. Reset windowed counts, then fill from the raw table.
    //    Reset first so programs that went quiet drop to 0 instead of
    //    keeping stale counts forever.
    await client.query(`
      UPDATE sonar.programs SET
        tx_count_24h = 0, tx_count_7d = 0, tx_count_30d = 0,
        unique_signers_24h = 0, unique_signers_7d = 0, unique_signers_30d = 0,
        success_rate_24h = NULL
    `);

    await client.query(`
      UPDATE sonar.programs p SET
        tx_count_30d       = a.tx_30d,
        unique_signers_30d = a.signers_30d,
        tx_count_7d        = a.tx_7d,
        unique_signers_7d  = a.signers_7d,
        tx_count_24h       = a.tx_24h,
        unique_signers_24h = a.signers_24h,
        success_rate_24h   = a.success_rate_24h
      FROM (
        SELECT program_id,
               COUNT(*)                                            AS tx_30d,
               COUNT(DISTINCT signer)                              AS signers_30d,
               COUNT(*)          FILTER (WHERE ts > NOW() - INTERVAL '7 days')  AS tx_7d,
               COUNT(DISTINCT signer) FILTER (WHERE ts > NOW() - INTERVAL '7 days')  AS signers_7d,
               COUNT(*)          FILTER (WHERE ts > NOW() - INTERVAL '24 hours') AS tx_24h,
               COUNT(DISTINCT signer) FILTER (WHERE ts > NOW() - INTERVAL '24 hours') AS signers_24h,
               CASE WHEN COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '24 hours') > 0
                    THEN (COUNT(*) FILTER (WHERE success AND ts > NOW() - INTERVAL '24 hours'))::real
                       / (COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '24 hours'))
                    ELSE NULL END                                  AS success_rate_24h
        FROM sonar.interactions
        WHERE ts > NOW() - INTERVAL '30 days'
        GROUP BY program_id
      ) a
      WHERE p.program_id = a.program_id
    `);

    // 2. Sonar Score (Theo's weights):
    //    0.35 * log-normalized 30d tx
    //  + 0.45 * log-normalized 30d signers
    //  + 0.15 * recency (linear decay over 7 days)
    //  + 0.05 * age bonus (1.0 if >30 days old, else 0.5)
    //    Volume + signers now range over the trailing 30 days; recency keeps
    //    its 7-day liveness decay. NULLIF guards the all-zero cold-start case.
    //    Closed programs are excluded from ranking: they don't feed the max
    //    normalization and their own score is forced to 0 (history is kept).
    await client.query(`
      WITH mx AS (
        SELECT MAX(tx_count_30d) AS max_tx, MAX(unique_signers_30d) AS max_s
        FROM sonar.programs
        WHERE closed_at IS NULL
      )
      UPDATE sonar.programs p SET sonar_score = CASE WHEN p.closed_at IS NOT NULL THEN 0 ELSE ROUND((
        0.35 * COALESCE(LN(p.tx_count_30d + 1) / NULLIF(LN(mx.max_tx + 1), 0), 0)
      + 0.45 * COALESCE(LN(p.unique_signers_30d + 1) / NULLIF(LN(mx.max_s + 1), 0), 0)
      + 0.15 * GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - p.last_active_at)) / 604800.0)
      + 0.05 * CASE WHEN p.first_seen_at < NOW() - INTERVAL '30 days' THEN 1.0 ELSE 0.5 END
      )::numeric * 1000, 2) END
      FROM mx
    `);

    // 2b. Apply the known-program registry (registry.json, PR-able in the repo).
    //     Names/categories are declarative: edit file → next run applies.
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'registry.json'), 'utf8'));
      for (const [programId, meta] of Object.entries(reg)) {
        if (programId.startsWith('_') || !meta || !meta.name) continue;
        await client.query(
          `UPDATE sonar.programs
           SET name = $2, category = COALESCE($3, category), website = COALESCE($4, website),
               infrastructure = $5, verified = TRUE
           WHERE program_id = $1`,
          [programId, meta.name, meta.category || null, meta.website || null, meta.infrastructure === true]
        );
      }
    } catch (e) {
      console.error('[sonar-aggregate] registry skipped:', e.message);
    }

    // 2c. Objective on-chain signals — recomputed every tick from columns we
    //     already maintain. These are FACTS, not verdicts: the reader judges.
    //     Runs AFTER the registry merge so `concentrated` sees final categories
    //     and `anonymous` sees registry-supplied names/websites. Ordered most-
    //     to-least notable; `upgradeable` is deliberately last (lowest weight).
    //       new          → first tx within 30 days
    //       concentrated → <=3 signers while >=50 txs in 30d, USER-FACING cats
    //                      only (crank/keeper wallets are normal for the rest)
    //       upgradeable  → program code can still change (informational)
    //       anonymous    → no registry name and no website
    //       failures     → <50% success over >=20 txs in 24h
    //       cliff        → >=1000 all-time txs but <=5 in the last 30d
    //       closed       → account no longer exists on-chain (see closed_at)
    await client.query(`
      UPDATE sonar.programs p SET signals = (
        SELECT COALESCE(jsonb_agg(x.sig ORDER BY x.ord), '[]'::jsonb)
        FROM (
                    SELECT 'closed'::text AS sig, 0 AS ord WHERE p.closed_at IS NOT NULL
          UNION ALL SELECT 'failures',       1 WHERE p.success_rate_24h < 0.5 AND p.tx_count_24h >= 20
          UNION ALL SELECT 'concentrated',   2 WHERE p.unique_signers_30d <= 3 AND p.tx_count_30d >= 50
                        AND p.infrastructure IS NOT TRUE
                        AND p.category IN ('DEX','Token','NFT','Marketplace','Game','Staking')
          UNION ALL SELECT 'cliff',          3 WHERE p.tx_all_time IS NOT NULL AND p.tx_all_time >= 1000 AND p.tx_count_30d <= 5
          UNION ALL SELECT 'anonymous',      4 WHERE p.website IS NULL AND p.name IS NULL
          UNION ALL SELECT 'new',            5 WHERE p.first_tx_at IS NOT NULL AND p.first_tx_at > NOW() - INTERVAL '30 days'
          UNION ALL SELECT 'upgradeable',    6 WHERE p.upgrade_state = 'upgradeable'
        ) x
      )
    `);

    // 3. Daily rollups — today + yesterday (UTC), replay-safe upsert
    await client.query(`
      INSERT INTO sonar.daily_stats (program_id, date, tx_count, unique_signers)
      SELECT program_id, ts::date, COUNT(*), COUNT(DISTINCT signer)
      FROM sonar.interactions
      WHERE ts >= (CURRENT_DATE - INTERVAL '1 day')
      GROUP BY program_id, ts::date
      ON CONFLICT (program_id, date) DO UPDATE SET
        tx_count = EXCLUDED.tx_count,
        unique_signers = EXCLUDED.unique_signers
    `);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // 5. Refresh upgrade state per program (RPC, outside the txn).
  //    Only re-reads programs missing state or stale >6h — cheap, self-healing.
  try {
    const { rows: need } = await pool.query(`
      SELECT program_id FROM sonar.programs
      WHERE upgrade_state IS NULL OR upgrade_state = 'upgradeable'
      ORDER BY sonar_score DESC LIMIT 50
    `);
    for (const { program_id } of need) {
      try {
        const { state, authority } = await readUpgradeState(program_id);
        await pool.query(
          `UPDATE sonar.programs SET upgrade_state = $2, upgrade_authority = $3 WHERE program_id = $1`,
          [program_id, state, authority]
        );
        await sleep(120); // pace RPC — validator-safe
      } catch (e) {
        // leave state as-is on a transient error
      }
    }
  } catch (e) {
    console.error('[sonar-aggregate] upgrade-state refresh skipped:', e.message);
  }

  // 6. Prune outside the main transaction (can be a big delete)
  const pruned = await pool.query(
    `DELETE FROM sonar.interactions WHERE ts < NOW() - ($1 || ' days')::interval`,
    [RETENTION_DAYS]
  );

  console.log(`[sonar-aggregate] done in ${Date.now() - t0}ms | pruned ${pruned.rowCount} rows`);
}

if (require.main === module) {
  aggregate()
    .then(() => pool.end())
    .catch((e) => {
      console.error('[sonar-aggregate] Fatal:', e.message);
      process.exit(1);
    });
}

module.exports = { aggregate, pool };

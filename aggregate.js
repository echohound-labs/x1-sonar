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

async function aggregate() {
  const client = await pool.connect();
  const t0 = Date.now();
  try {
    await client.query('BEGIN');

    // 1. Reset windowed counts, then fill from the raw table.
    //    Reset first so programs that went quiet drop to 0 instead of
    //    keeping stale counts forever.
    await client.query(`
      UPDATE sonar.programs SET
        tx_count_24h = 0, tx_count_7d = 0,
        unique_signers_24h = 0, unique_signers_7d = 0,
        success_rate_24h = NULL
    `);

    await client.query(`
      UPDATE sonar.programs p SET
        tx_count_7d        = a.tx_7d,
        unique_signers_7d  = a.signers_7d,
        tx_count_24h       = a.tx_24h,
        unique_signers_24h = a.signers_24h,
        success_rate_24h   = a.success_rate_24h
      FROM (
        SELECT program_id,
               COUNT(*)                                            AS tx_7d,
               COUNT(DISTINCT signer)                              AS signers_7d,
               COUNT(*)          FILTER (WHERE ts > NOW() - INTERVAL '24 hours') AS tx_24h,
               COUNT(DISTINCT signer) FILTER (WHERE ts > NOW() - INTERVAL '24 hours') AS signers_24h,
               CASE WHEN COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '24 hours') > 0
                    THEN (COUNT(*) FILTER (WHERE success AND ts > NOW() - INTERVAL '24 hours'))::real
                       / (COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '24 hours'))
                    ELSE NULL END                                  AS success_rate_24h
        FROM sonar.interactions
        WHERE ts > NOW() - INTERVAL '7 days'
        GROUP BY program_id
      ) a
      WHERE p.program_id = a.program_id
    `);

    // 2. Sonar Score (Theo's weights):
    //    0.35 * log-normalized 7d tx
    //  + 0.45 * log-normalized 7d signers
    //  + 0.15 * recency (linear decay over 7 days)
    //  + 0.05 * age bonus (1.0 if >30 days old, else 0.5)
    //    NULLIF guards the all-zero cold-start case.
    await client.query(`
      WITH mx AS (
        SELECT MAX(tx_count_7d) AS max_tx, MAX(unique_signers_7d) AS max_s
        FROM sonar.programs
      )
      UPDATE sonar.programs p SET sonar_score = ROUND((
        0.35 * COALESCE(LN(p.tx_count_7d + 1) / NULLIF(LN(mx.max_tx + 1), 0), 0)
      + 0.45 * COALESCE(LN(p.unique_signers_7d + 1) / NULLIF(LN(mx.max_s + 1), 0), 0)
      + 0.15 * GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - p.last_active_at)) / 604800.0)
      + 0.05 * CASE WHEN p.first_seen_at < NOW() - INTERVAL '30 days' THEN 1.0 ELSE 0.5 END
      )::numeric * 1000, 2)
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

// X1 Sonar — block indexer
// Scans X1 blocks from localhost RPC, records program interactions.
// Votes and ComputeBudget instructions are filtered at ingest.
//
// Resume-safe: checkpoints last processed slot in sonar.checkpoint.
// Validator-safe: paced RPC calls, never outruns the confirmed tip.

require('dotenv').config();
const { Connection } = require('@solana/web3.js');
const { Pool } = require('pg');

const RPC_URL = process.env.X1_RPC_URL || 'http://localhost:8899';
const DB_URL = process.env.DATABASE_URL;
const CATCHUP_DELAY_MS = parseInt(process.env.CATCHUP_DELAY_MS || '100', 10); // pace while behind tip
const TIP_WAIT_MS = parseInt(process.env.TIP_WAIT_MS || '500', 10);           // wait when caught up
const CHECKPOINT_EVERY = parseInt(process.env.CHECKPOINT_EVERY || '25', 10);  // slots

// Programs excluded at ingest — they'd dominate every metric and 50x the table.
const EXCLUDED_PROGRAMS = new Set([
  'Vote111111111111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
]);

const connection = new Connection(RPC_URL, 'confirmed');
const pool = new Pool({ connectionString: DB_URL });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCheckpoint() {
  const { rows } = await pool.query('SELECT last_slot FROM sonar.checkpoint WHERE id = 1');
  return rows.length ? Number(rows[0].last_slot) : null;
}

async function saveCheckpoint(slot) {
  await pool.query(
    `INSERT INTO sonar.checkpoint (id, last_slot, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET last_slot = $1, updated_at = NOW()`,
    [slot]
  );
}

// Extract per-program interaction rows from one block
function extractInteractions(block, slot) {
  const ts = block.blockTime ? new Date(block.blockTime * 1000) : new Date();
  const rows = [];

  for (const tx of block.transactions) {
    const msg = tx.transaction.message;
    const meta = tx.meta;

    // Full key list: static keys + any addresses loaded via lookup tables (v0 txs)
    const keys = msg.staticAccountKeys
      ? msg.staticAccountKeys.map(String)
      : msg.accountKeys.map(String);
    if (meta && meta.loadedAddresses) {
      for (const k of meta.loadedAddresses.writable || []) keys.push(String(k));
      for (const k of meta.loadedAddresses.readonly || []) keys.push(String(k));
    }

    const signer = keys[0] || null;
    const success = !meta || meta.err === null;
    const signature = tx.transaction.signatures[0];

    const instructions = msg.compiledInstructions || msg.instructions || [];
    const seen = new Set(); // dedupe program per tx (top-level + CPI count once)

    const credit = (idx) => {
      const programId = keys[idx];
      if (!programId || EXCLUDED_PROGRAMS.has(programId) || seen.has(programId)) return;
      seen.add(programId);
      rows.push({ programId, signature, slot, signer, success, ts });
    };

    // Top-level instructions
    for (const ix of instructions) credit(ix.programIdIndex);

    // Inner instructions (CPIs) — programs invoked BY other programs get
    // credited too, so composable infra (oracles, routers, token engines)
    // is measured by its real consumers, not just direct callers.
    for (const inner of (meta && meta.innerInstructions) || []) {
      for (const ix of inner.instructions || []) {
        if (ix.programIdIndex !== undefined) credit(ix.programIdIndex);
      }
    }
  }
  return rows;
}

// Batched write: raw interactions + program upserts, one transaction
async function writeBatch(rows) {
  if (!rows.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // interactions — multi-row insert, dedupe on (program_id, signature)
    const vals = [];
    const params = [];
    rows.forEach((r, i) => {
      const o = i * 6;
      vals.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`);
      params.push(r.programId, r.signature, r.slot, r.signer, r.success, r.ts);
    });
    const inserted = await client.query(
      `INSERT INTO sonar.interactions (program_id, signature, slot, signer, success, ts)
       VALUES ${vals.join(',')}
       ON CONFLICT (program_id, signature) DO NOTHING
       RETURNING program_id`,
      params
    );

    // programs — first_seen / last_active / all-time count
    const counts = new Map();
    for (const row of inserted.rows) {
      counts.set(row.program_id, (counts.get(row.program_id) || 0) + 1);
    }
    for (const [programId, n] of counts) {
      const sample = rows.find((r) => r.programId === programId);
      await client.query(
        `INSERT INTO sonar.programs (program_id, first_seen_slot, first_seen_at, last_active_at, tx_count_all)
         VALUES ($1, $2, $3, $3, $4)
         ON CONFLICT (program_id) DO UPDATE SET
           last_active_at = GREATEST(sonar.programs.last_active_at, EXCLUDED.last_active_at),
           tx_count_all   = sonar.programs.tx_count_all + EXCLUDED.tx_count_all`,
        [programId, sample.slot, sample.ts, n]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function isSkippedSlotError(e) {
  const msg = String(e.message || e);
  return (
    msg.includes('was skipped') ||
    msg.includes('missing due to ledger jump') ||
    msg.includes('-32007') ||
    msg.includes('-32009')
  );
}

async function main() {
  console.log(`[sonar-indexer] RPC: ${RPC_URL}`);

  let slot = await getCheckpoint();
  if (slot === null) {
    slot = await connection.getSlot('confirmed');
    console.log(`[sonar-indexer] No checkpoint — starting at current slot ${slot}`);
  } else {
    slot += 1;
    console.log(`[sonar-indexer] Resuming from checkpoint, slot ${slot}`);
  }

  let tip = await connection.getSlot('confirmed');
  let processed = 0;
  let statRows = 0;
  let statStart = Date.now();

  while (true) {
    try {
      // Never outrun the confirmed tip
      if (slot > tip) {
        tip = await connection.getSlot('confirmed');
        if (slot > tip) {
          await sleep(TIP_WAIT_MS);
          continue;
        }
      }

      const block = await connection.getBlock(slot, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: 'full',
        rewards: false,
      });

      if (block) {
        const rows = extractInteractions(block, slot);
        await writeBatch(rows);
        statRows += rows.length;
      }

      processed += 1;
      if (processed % CHECKPOINT_EVERY === 0) {
        await saveCheckpoint(slot);
        const elapsed = (Date.now() - statStart) / 1000;
        const behind = tip - slot;
        console.log(
          `[sonar-indexer] slot ${slot} | ${(CHECKPOINT_EVERY / elapsed).toFixed(1)} slots/s | ` +
          `${statRows} interactions | ${behind > 0 ? behind + ' behind tip' : 'at tip'}`
        );
        statRows = 0;
        statStart = Date.now();
      }

      slot += 1;
      if (slot <= tip) await sleep(CATCHUP_DELAY_MS);
    } catch (e) {
      if (isSkippedSlotError(e)) {
        slot += 1; // skipped slot, normal on SVM chains
        continue;
      }
      console.error(`[sonar-indexer] Error at slot ${slot}: ${e.message}`);
      await sleep(2000); // transient RPC error — retry same slot
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[sonar-indexer] Fatal:', e);
    process.exit(1);
  });
}

module.exports = { extractInteractions, isSkippedSlotError, EXCLUDED_PROGRAMS, writeBatchForTest: writeBatch };

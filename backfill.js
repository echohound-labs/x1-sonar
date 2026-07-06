// X1 Sonar — backfill.js
// Walk ONE program's transaction history backward via getSignaturesForAddress.
//
// Two modes:
//   FULL (default)  — page all the way to the program's first tx. Count total
//                     txs, ok vs failed, and the oldest tx timestamp. With
//                     --commit, add sonar.programs.tx_all_time / first_tx_at
//                     and UPDATE this program's row.
//   --days N        — walk back only N days (stop at the blockTime cutoff).
//                     With --commit, fetch each tx (getTransaction, encoding
//                     json) and INSERT into sonar.interactions so the score
//                     windows have history to chew on.
//
// Dry-run by default: prints totals, writes NOTHING without --commit.
//
// Usage:
//   node backfill.js <PROGRAM_ID> [--days N] [--commit] [--rpc url] [--throttle ms]

require('dotenv').config();
const { Client } = require('pg');

const DEFAULT_RPC = 'https://rpc.mainnet.x1.xyz';
const DEFAULT_THROTTLE_MS = 250;
const PAGE_LIMIT = 1000;         // getSignaturesForAddress max
const MAX_ATTEMPTS = 5;          // retries per RPC call
const BACKOFF_BASE_MS = 500;     // exponential backoff base

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { programId: null, days: null, commit: false, rpc: DEFAULT_RPC, throttle: DEFAULT_THROTTLE_MS };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--commit') opts.commit = true;
    else if (a === '--days') opts.days = parseInt(rest[++i], 10);
    else if (a === '--rpc') opts.rpc = rest[++i];
    else if (a === '--throttle') opts.throttle = parseInt(rest[++i], 10);
    else if (!a.startsWith('--') && !opts.programId) opts.programId = a;
    else { console.error(`unknown argument: ${a}`); process.exit(1); }
  }
  return opts;
}

// JSON-RPC call with exponential backoff on errors / 429s.
let rpcId = 0;
async function rpc(url, method, params) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      if (res.status === 429) throw new Error('HTTP 429 (rate limited)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(`${method}: ${j.error.message} (${j.error.code})`);
      return j.result;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS - 1) {
        const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
        console.error(`  [retry ${attempt + 1}/${MAX_ATTEMPTS - 1}] ${method}: ${e.message} — backing off ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

const iso = (blockTime) => (blockTime != null ? new Date(blockTime * 1000).toISOString() : '(unknown)');

// Page getSignaturesForAddress backward. `stopBefore` is an optional unix-seconds
// cutoff (--days mode): once we cross it we stop. Returns collected stats and,
// for --days mode, the in-window signature entries (needed for --commit).
async function walk(opts, stopBefore) {
  let before;
  let page = 0;
  let total = 0, ok = 0, failed = 0;
  let oldestBlockTime = null;
  const windowSigs = [];

  outer: while (true) {
    const params = [opts.programId, { limit: PAGE_LIMIT }];
    if (before) params[1].before = before;

    const sigs = await rpc(opts.rpc, 'getSignaturesForAddress', params);
    await sleep(opts.throttle);
    if (!sigs || sigs.length === 0) break;

    for (const s of sigs) {
      // --days: signatures are newest-first, so the first one older than the
      // cutoff marks the edge of our window — everything after is older too.
      if (stopBefore != null && s.blockTime != null && s.blockTime < stopBefore) break outer;

      total++;
      if (s.err) failed++; else ok++;
      if (s.blockTime != null && (oldestBlockTime === null || s.blockTime < oldestBlockTime)) {
        oldestBlockTime = s.blockTime;
      }
      if (stopBefore != null) windowSigs.push(s);
    }

    before = sigs[sigs.length - 1].signature;
    page++;
    if (page % 5 === 0) {
      console.log(`  … page ${page} | ${total} txs so far | oldest ${iso(oldestBlockTime)}`);
    }
    if (sigs.length < PAGE_LIMIT) break; // short page = end of history
  }

  return { pages: page, total, ok, failed, oldestBlockTime, windowSigs };
}

async function commitFull(opts, stats) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `ALTER TABLE sonar.programs
         ADD COLUMN IF NOT EXISTS tx_all_time BIGINT,
         ADD COLUMN IF NOT EXISTS first_tx_at TIMESTAMPTZ`
    );
    const firstTxAt = stats.oldestBlockTime != null ? new Date(stats.oldestBlockTime * 1000) : null;
    const res = await client.query(
      `UPDATE sonar.programs SET tx_all_time = $1, first_tx_at = $2 WHERE program_id = $3`,
      [stats.total, firstTxAt, opts.programId]
    );
    if (res.rowCount === 0) {
      console.log(`  ⚠ no sonar.programs row for ${opts.programId} — nothing updated (insert it first)`);
    } else {
      console.log(`  ✓ updated sonar.programs: tx_all_time=${stats.total}, first_tx_at=${firstTxAt ? firstTxAt.toISOString() : 'NULL'}`);
    }
  } finally {
    await client.end();
  }
}

async function commitDays(opts, stats) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let inserted = 0, skipped = 0, fetched = 0;
  try {
    for (const s of stats.windowSigs) {
      const tx = await rpc(opts.rpc, 'getTransaction', [
        s.signature,
        { encoding: 'json', maxSupportedTransactionVersion: 0 },
      ]);
      await sleep(opts.throttle);
      fetched++;
      if (!tx) { skipped++; continue; }

      const signer = tx.transaction.message.accountKeys[0] || null;
      const success = !tx.meta || tx.meta.err === null;
      const slot = tx.slot;
      const blockTime = tx.blockTime != null ? tx.blockTime : s.blockTime;
      const ts = blockTime != null ? new Date(blockTime * 1000) : new Date();

      const res = await client.query(
        `INSERT INTO sonar.interactions (program_id, signature, slot, signer, success, ts)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (signature, program_id) DO NOTHING`,
        [opts.programId, s.signature, slot, signer, success, ts]
      );
      if (res.rowCount > 0) inserted++; else skipped++;

      if (fetched % 100 === 0) {
        console.log(`  … committed ${fetched}/${stats.windowSigs.length} | ${inserted} inserted, ${skipped} skipped`);
      }
    }
    console.log(`  ✓ sonar.interactions: ${inserted} inserted, ${skipped} skipped (of ${stats.windowSigs.length})`);
  } finally {
    await client.end();
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.programId) {
    console.error('usage: node backfill.js <PROGRAM_ID> [--days N] [--commit] [--rpc url] [--throttle ms]');
    process.exit(1);
  }
  if (opts.commit && !process.env.DATABASE_URL) {
    console.error('--commit requires DATABASE_URL in .env');
    process.exit(1);
  }

  const mode = opts.days != null ? `--days ${opts.days}` : 'FULL';
  console.log(`\nX1 Sonar backfill — ${mode}${opts.commit ? ' (COMMIT)' : ' (dry-run)'}`);
  console.log(`  program : ${opts.programId}`);
  console.log(`  rpc     : ${opts.rpc}`);
  console.log(`  throttle: ${opts.throttle}ms\n`);

  let stopBefore = null;
  if (opts.days != null) {
    stopBefore = Math.floor(Date.now() / 1000) - opts.days * 86400;
    console.log(`  cutoff  : ${iso(stopBefore)} (${opts.days} days back)\n`);
  }

  const stats = await walk(opts, stopBefore);

  console.log(`\nResults:`);
  console.log(`  pages walked : ${stats.pages}`);
  console.log(`  total txs    : ${stats.total}`);
  console.log(`  ok / failed  : ${stats.ok} / ${stats.failed}`);
  console.log(`  oldest tx    : ${iso(stats.oldestBlockTime)}`);
  if (opts.days != null) {
    console.log(`  in-window    : ${stats.windowSigs.length} signatures`);
  }

  if (!opts.commit) {
    console.log(`\nDry-run — nothing written. Re-run with --commit to persist.\n`);
    return;
  }

  console.log(`\nCommitting…`);
  if (opts.days != null) await commitDays(opts, stats);
  else await commitFull(opts, stats);
  console.log();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[backfill] Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, walk };

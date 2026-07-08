// X1 Sonar — backfill.js
// Walk ONE program's transaction history backward via getSignaturesForAddress.
//
// Two modes:
//   FULL (default)  — page all the way to the program's first tx. Count total
//                     txs, ok vs failed, and the oldest tx timestamp. With
//                     --commit, add sonar.programs.tx_all_time / first_tx_at
//                     and UPDATE this program's row.
//   --days N        — walk back only N days (stop at the blockTime cutoff).
//                     With --commit, fetch txs via batched JSON-RPC
//                     (getTransaction, ~50 per POST) and INSERT into
//                     sonar.interactions so the score windows have history to
//                     chew on.
//
// Dry-run by default: prints totals, writes NOTHING without --commit.
//
// FULL mode is CHECKPOINTED: paging progress is persisted to
// backfill-state-<PROGRAM_ID>.json every --checkpoint pages (default 25), so a
// death on a huge program (Memo etc.) never loses everything — re-run with
// --resume to continue from the last saved cursor. The state file is deleted on
// successful completion. Failures are LOUD: any error prints a stack before exit.
//
// Usage:
//   node backfill.js <PROGRAM_ID> [--days N] [--commit] [--resume]
//                    [--checkpoint N] [--rpc url] [--throttle ms]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DEFAULT_RPC = 'https://rpc.mainnet.x1.xyz';
const DEFAULT_THROTTLE_MS = 250;
const DEFAULT_CHECKPOINT_PAGES = 25; // persist FULL-walk progress every N pages
const PAGE_LIMIT = 1000;         // getSignaturesForAddress max
const MAX_ATTEMPTS = 5;          // retries per RPC call (getTransaction / batches)
const BACKOFF_BASE_MS = 500;     // exponential backoff base
const SIG_MAX_RETRIES = 5;       // getSignaturesForAddress: retries before giving up
const SIG_BACKOFF_BASE_MS = 1000; // → 1s, 2s, 4s, 8s, 16s
const BATCH_SIZE = 50;           // getTransaction calls per batched JSON-RPC POST (--days)
const FALLBACK_BATCH_SIZE = 10;  // shrink to this if a full batch fails at the batch level

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = {
    programId: null, days: null, commit: false, resume: false,
    checkpoint: DEFAULT_CHECKPOINT_PAGES, rpc: DEFAULT_RPC, throttle: DEFAULT_THROTTLE_MS,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--commit') opts.commit = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--days') opts.days = parseInt(rest[++i], 10);
    else if (a === '--checkpoint') opts.checkpoint = parseInt(rest[++i], 10);
    else if (a === '--rpc') opts.rpc = rest[++i];
    else if (a === '--throttle') opts.throttle = parseInt(rest[++i], 10);
    else if (!a.startsWith('--') && !opts.programId) opts.programId = a;
    else { console.error(`unknown argument: ${a}`); process.exit(1); }
  }
  if (!Number.isInteger(opts.checkpoint) || opts.checkpoint < 1) opts.checkpoint = DEFAULT_CHECKPOINT_PAGES;
  return opts;
}

// ── checkpoint state (FULL mode) — atomic JSON writes ────────
const checkpointPath = (programId) => path.join(__dirname, `backfill-state-${programId}.json`);
function readCheckpoint(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function writeCheckpoint(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // atomic on the same filesystem
}
function deleteCheckpoint(file) {
  try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
}

// JSON-RPC call with exponential backoff on errors / 429s. maxAttempts can be
// overridden (getSignaturesPage drives its own retry loop with maxAttempts:1).
let rpcId = 0;
async function rpc(url, method, params, { maxAttempts = MAX_ATTEMPTS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
      if (attempt < maxAttempts - 1) {
        const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
        console.error(`  [retry ${attempt + 1}/${maxAttempts - 1}] ${method}: ${e.message} — backing off ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

// One getSignaturesForAddress page, retried up to SIG_MAX_RETRIES times with
// 1s/2s/4s/8s/16s backoff. When it finally gives up it throws — in FULL mode the
// last checkpoint means --resume picks up from where we left off.
async function getSignaturesPage(opts, params) {
  let lastErr;
  for (let attempt = 0; attempt <= SIG_MAX_RETRIES; attempt++) {
    try {
      return await rpc(opts.rpc, 'getSignaturesForAddress', params, { maxAttempts: 1 });
    } catch (e) {
      lastErr = e;
      if (attempt < SIG_MAX_RETRIES) {
        const backoff = SIG_BACKOFF_BASE_MS * Math.pow(2, attempt); // 1s,2s,4s,8s,16s
        console.error(`  [sig retry ${attempt + 1}/${SIG_MAX_RETRIES}] getSignaturesForAddress: ${e.message} — backing off ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

// Batched JSON-RPC: send an array of {method, params} in ONE POST. Returns
// results aligned to the input order (responses are matched back by id, since
// servers may reorder or interleave them). Per-item errors resolve to null.
// Throws on a batch-level failure (HTTP error, 429, or a non-array body — some
// servers answer a bad batch with a single error object) so callers can retry
// with a smaller batch.
async function rpcBatch(url, calls) {
  const body = calls.map((c) => ({ jsonrpc: '2.0', id: ++rpcId, method: c.method, params: c.params }));
  const idToIndex = new Map(body.map((b, idx) => [b.id, idx]));
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 429) throw new Error('HTTP 429 (rate limited)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!Array.isArray(j)) {
        const msg = j && j.error ? `${j.error.message} (${j.error.code})` : 'non-array batch response';
        throw new Error(`batch(${calls.length}): ${msg}`);
      }
      const out = new Array(calls.length).fill(null);
      for (const r of j) {
        const idx = idToIndex.get(r.id);
        if (idx == null) continue;          // stray id — ignore
        out[idx] = r.error ? null : r.result; // per-item error → null (skip)
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS - 1) {
        const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
        console.error(`  [retry ${attempt + 1}/${MAX_ATTEMPTS - 1}] batch(${calls.length}): ${e.message} — backing off ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

// Fetch getTransaction for a chunk of signatures via batched JSON-RPC, degrading
// gracefully: one POST for the whole chunk → batches of FALLBACK_BATCH_SIZE →
// single calls. Returns tx-or-null aligned to `sigs` order (nulls are skipped by
// the caller). Throttles between the network round-trips it makes, not per item.
async function fetchTxBatch(opts, sigs) {
  const mk = (s) => ({
    method: 'getTransaction',
    params: [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
  });

  try {
    const r = await rpcBatch(opts.rpc, sigs.map(mk));
    await sleep(opts.throttle);
    return r;
  } catch (e) {
    console.error(`  batch of ${sigs.length} failed at batch level (${e.message}) — falling back to size ${FALLBACK_BATCH_SIZE}`);
  }

  const out = [];
  for (let i = 0; i < sigs.length; i += FALLBACK_BATCH_SIZE) {
    const sub = sigs.slice(i, i + FALLBACK_BATCH_SIZE);
    try {
      const r = await rpcBatch(opts.rpc, sub.map(mk));
      out.push(...r);
      await sleep(opts.throttle);
    } catch (e2) {
      console.error(`  sub-batch of ${sub.length} failed (${e2.message}) — falling back to single calls`);
      for (const s of sub) {
        try {
          out.push(await rpc(opts.rpc, 'getTransaction', mk(s).params));
        } catch (e3) {
          console.error(`  single getTransaction failed for ${s.signature} (${e3.message}) — skipping`);
          out.push(null);
        }
        await sleep(opts.throttle);
      }
    }
  }
  return out;
}

const iso = (blockTime) => (blockTime != null ? new Date(blockTime * 1000).toISOString() : '(unknown)');

// Page getSignaturesForAddress backward. `stopBefore` is an optional unix-seconds
// cutoff (--days mode): once we cross it we stop. `checkpoint` (FULL mode only)
// is { path, everyPages, resume } — progress is persisted every `everyPages`
// pages and, if `resume` holds a prior state, the walk continues from its cursor.
// Returns collected stats and, for --days mode, the in-window signature entries.
// Only running counters + the cursor are held in memory (FULL never buffers sigs).
async function walk(opts, stopBefore, checkpoint) {
  let before;
  let page = 0;
  let total = 0, ok = 0, failed = 0;
  let oldestBlockTime = null;
  const windowSigs = [];

  if (checkpoint && checkpoint.resume) {
    const r = checkpoint.resume;
    before = r.before_cursor || undefined;
    page = r.pages || 0;
    total = r.total || 0;
    ok = r.ok || 0;
    failed = r.failed || 0;
    oldestBlockTime = r.oldest_ts != null ? r.oldest_ts : null;
    console.log(`  ↻ resuming from page ${page} | ${total} txs so far | cursor ${before ? before.slice(0, 12) + '…' : '(start)'}`);
  }

  const saveCheckpoint = () => {
    if (!checkpoint) return;
    writeCheckpoint(checkpoint.path, {
      before_cursor: before || null, pages: page, total, ok, failed, oldest_ts: oldestBlockTime,
    });
    console.log(`  ✓ checkpoint saved at page ${page} (${total} txs) → ${path.basename(checkpoint.path)}`);
  };

  outer: while (true) {
    const params = [opts.programId, { limit: PAGE_LIMIT }];
    if (before) params[1].before = before;

    const sigs = await getSignaturesPage(opts, params);
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
    if (checkpoint && page % checkpoint.everyPages === 0) saveCheckpoint();
    if (sigs.length < PAGE_LIMIT) break; // short page = end of history
  }

  return { pages: page, total, ok, failed, oldestBlockTime, windowSigs };
}

async function commitFull(opts, stats) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Columns are added manually by the DBA; the runtime role may not own the
    // table. Try anyway, but tolerate the privilege error and keep going —
    // the UPDATE below is what matters.
    try {
      await client.query(
        `ALTER TABLE sonar.programs
           ADD COLUMN IF NOT EXISTS tx_all_time BIGINT,
           ADD COLUMN IF NOT EXISTS first_tx_at TIMESTAMPTZ`
      );
    } catch (e) {
      console.log(`  · skipping ALTER TABLE (${e.message}) — assuming columns managed by DBA`);
    }
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
    const sigs = stats.windowSigs;
    for (let start = 0; start < sigs.length; start += BATCH_SIZE) {
      const chunk = sigs.slice(start, start + BATCH_SIZE);
      const txs = await fetchTxBatch(opts, chunk); // aligned to chunk order

      for (let k = 0; k < chunk.length; k++) {
        const s = chunk[k];
        const tx = txs[k];
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
      }

      console.log(`  … committed ${fetched}/${sigs.length} | ${inserted} inserted, ${skipped} skipped`);
    }
    console.log(`  ✓ sonar.interactions: ${inserted} inserted, ${skipped} skipped (of ${sigs.length})`);
  } finally {
    await client.end();
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.programId) {
    console.error('usage: node backfill.js <PROGRAM_ID> [--days N] [--commit] [--resume] [--checkpoint N] [--rpc url] [--throttle ms]');
    process.exit(1);
  }
  if (opts.commit && !process.env.DATABASE_URL) {
    console.error('--commit requires DATABASE_URL in .env');
    process.exit(1);
  }

  const isFull = opts.days == null;
  const mode = isFull ? 'FULL' : `--days ${opts.days}`;
  console.log(`\nX1 Sonar backfill — ${mode}${opts.commit ? ' (COMMIT)' : ' (dry-run)'}`);
  console.log(`  program : ${opts.programId}`);
  console.log(`  rpc     : ${opts.rpc}`);
  console.log(`  throttle: ${opts.throttle}ms`);

  // Checkpointing is FULL-mode only. --days walks a bounded recent window and
  // must buffer its signatures for --commit, so it stays exactly as before.
  let checkpoint = null;
  if (isFull) {
    const file = checkpointPath(opts.programId);
    let resume = null;
    if (opts.resume) {
      resume = readCheckpoint(file);
      console.log(resume
        ? `  resume  : ${path.basename(file)} — page ${resume.pages || 0}, ${resume.total || 0} txs`
        : `  resume  : no state file at ${path.basename(file)} — starting fresh`);
    }
    checkpoint = { path: file, everyPages: opts.checkpoint, resume };
    console.log(`  checkpt : every ${opts.checkpoint} pages → ${path.basename(file)}`);
  } else if (opts.resume) {
    console.log(`  note    : --resume ignored (only applies to FULL mode)`);
  }
  console.log();

  let stopBefore = null;
  if (!isFull) {
    stopBefore = Math.floor(Date.now() / 1000) - opts.days * 86400;
    console.log(`  cutoff  : ${iso(stopBefore)} (${opts.days} days back)\n`);
  }

  const stats = await walk(opts, stopBefore, checkpoint);

  console.log(`\nResults:`);
  console.log(`  pages walked : ${stats.pages}`);
  console.log(`  total txs    : ${stats.total}`);
  console.log(`  ok / failed  : ${stats.ok} / ${stats.failed}`);
  console.log(`  oldest tx    : ${iso(stats.oldestBlockTime)}`);
  if (!isFull) {
    console.log(`  in-window    : ${stats.windowSigs.length} signatures`);
  }

  if (!opts.commit) {
    console.log(`\nDry-run — nothing written. Re-run with --commit to persist.\n`);
    if (checkpoint) deleteCheckpoint(checkpoint.path); // walk completed — no resume needed
    return;
  }

  console.log(`\nCommitting…`);
  if (!isFull) await commitDays(opts, stats);
  else await commitFull(opts, stats);

  // Only reached on a fully successful walk + commit — safe to drop the state.
  if (checkpoint) {
    deleteCheckpoint(checkpoint.path);
    console.log(`  ✓ removed checkpoint ${path.basename(checkpoint.path)}`);
  }
  console.log();
}

if (require.main === module) {
  // LOUD failure: a silent death must be impossible. Any unhandled error prints
  // a full stack before exit.
  process.on('unhandledRejection', (reason) => {
    console.error('[backfill] UNHANDLED REJECTION:');
    console.error(reason && reason.stack ? reason.stack : reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[backfill] UNCAUGHT EXCEPTION:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
  main().catch((e) => {
    console.error('[backfill] FATAL:');
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = { parseArgs, walk, readCheckpoint, writeCheckpoint, checkpointPath };

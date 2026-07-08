// X1 Sonar — idl-audit.js
// Read-only audit: for EVERY program in registry.json PLUS every row in
// sonar.programs, look for a published on-chain Anchor IDL and compare the IDL's
// declared name against the name we carry in the registry.
//
//   1. Derive the canonical Anchor IDL address per anchor-cli convention:
//        base = find_program_address([], programId)
//        idl  = createWithSeed(base, "anchor:idl", programId)
//      then getAccountInfo via X1_RPC_URL.
//   2. If present: skip the 44-byte account header (8 disc + 32 authority +
//      4 len), zlib-inflate the payload, JSON.parse it, and pull out name
//      (and metadata.name), version, and instruction names. Never crash on
//      malformed data — such accounts are reported as UNREADABLE.
//   3. Print a table: program_id | registry name | IDL name | verdict
//      (MATCH / MISMATCH / NO_IDL / UNREADABLE), mismatches first.
//
// READ-ONLY: no DB writes, no registry writes. Safe to run any time.
//
// The IDL helpers (deriveIdlAddress / parseIdlAccount) are exported so
// sonar-watch.js can reuse them for IDL-first evidence gathering.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PublicKey } = require('@solana/web3.js');
const { Pool } = require('pg');

// ── config ───────────────────────────────────────────────────
const RPC = process.env.X1_RPC_URL || 'http://localhost:8899';
const DB_URL = process.env.DATABASE_URL;
const REGISTRY_FILE = path.join(__dirname, 'registry.json');
const RPC_PACE_MS = 250; // validator-safe throttle, same as sonar-watch.js

const IDL_SEED = 'anchor:idl';
// IdlAccount on-chain layout: 8-byte account discriminator + 32-byte authority
// pubkey + 4-byte u32 LE length + `length` bytes of zlib-compressed IDL JSON.
const IDL_HEADER = 8 + 32 + 4; // 44

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── IDL address + parsing (exported, pure) ───────────────────
// Canonical anchor-cli IDL address. Async because createWithSeed is a Promise
// in @solana/web3.js v1.98.
async function deriveIdlAddress(programId) {
  const pid = new PublicKey(programId);
  const base = PublicKey.findProgramAddressSync([], pid)[0];
  const idl = await PublicKey.createWithSeed(base, IDL_SEED, pid);
  return idl.toBase58();
}

// Parse a raw IdlAccount data buffer (base64-decoded account.data). Throws on
// any malformed input so callers can mark the account UNREADABLE — it never
// returns partial garbage.
function parseIdlAccount(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < IDL_HEADER) {
    throw new Error(`account too short (${buf ? buf.length : 0} bytes)`);
  }
  const len = buf.readUInt32LE(40);
  if (len <= 0 || IDL_HEADER + len > buf.length) {
    throw new Error(`bad payload length ${len}`);
  }
  const compressed = buf.subarray(IDL_HEADER, IDL_HEADER + len);
  const json = zlib.inflateSync(compressed).toString('utf8');
  const idl = JSON.parse(json);
  const meta = idl.metadata || {};
  const name = idl.name || meta.name || null;
  const metadataName = meta.name || null;
  const version = idl.version || meta.version || null;
  const ixNames = Array.isArray(idl.instructions)
    ? idl.instructions.map((i) => i && i.name).filter(Boolean)
    : [];
  return { name, metadataName, version, ixNames };
}

module.exports = { deriveIdlAddress, parseIdlAccount };

// ── the rest only runs when invoked directly ─────────────────
if (require.main !== module) return;

// ── RPC (never throws; returns null on failure) ──────────────
let rpcId = 0;
async function rpc(method, params) {
  await sleep(RPC_PACE_MS);
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } catch (e) {
    console.error(`rpc ${method} failed:`, e.message);
    return null;
  }
}

// ── name normalisation / comparison ──────────────────────────
// IDL names are usually snake_case ("xdex_router"), registry names Title Case
// ("XDEX Router"). Strip everything but alphanumerics and lowercase, so the two
// conventions line up.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function verdictFor(registryName, idlName) {
  const r = norm(registryName);
  const i = norm(idlName);
  if (!i) return 'MISMATCH'; // IDL had no usable name field
  if (!r) return 'MISMATCH'; // we have no name to compare against
  if (r === i) return 'MATCH';
  // Tolerate one being a superset of the other (e.g. "Launchpad" vs
  // "degen_launchpad", "XDEX" vs "xdex_router").
  if (r.includes(i) || i.includes(r)) return 'MATCH';
  return 'MISMATCH';
}

// ── audit one program ────────────────────────────────────────
async function auditProgram(id, registryName) {
  let idlAddr;
  try {
    idlAddr = await deriveIdlAddress(id);
  } catch (e) {
    // A malformed program id (not on the registry/db as a real pubkey) — treat
    // as no IDL rather than crashing the whole run.
    return { id, registryName, idlName: null, version: null, verdict: 'NO_IDL', note: `bad id: ${e.message}` };
  }

  const acct = await rpc('getAccountInfo', [idlAddr, { encoding: 'base64' }]);
  if (!acct || !acct.value || !acct.value.data) {
    return { id, registryName, idlName: null, version: null, verdict: 'NO_IDL', idlAddr };
  }

  let parsed;
  try {
    const buf = Buffer.from(acct.value.data[0], 'base64');
    parsed = parseIdlAccount(buf);
  } catch (e) {
    return { id, registryName, idlName: null, version: null, verdict: 'UNREADABLE', idlAddr, note: e.message };
  }

  const idlName = parsed.name;
  return {
    id,
    registryName,
    idlName,
    version: parsed.version,
    verdict: verdictFor(registryName, idlName),
    idlAddr,
  };
}

// ── build the union of program ids ───────────────────────────
function readRegistry() {
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(reg)) {
      if (k.startsWith('_')) continue;
      out[k] = (v && v.name) || null;
    }
    return out;
  } catch (e) {
    console.error('could not read registry.json:', e.message);
    return {};
  }
}

async function readDbPrograms() {
  if (!DB_URL) {
    console.error('DATABASE_URL not set — auditing registry.json only');
    return {};
  }
  const pool = new Pool({ connectionString: DB_URL });
  try {
    const { rows } = await pool.query('SELECT program_id, name FROM sonar.programs');
    const out = {};
    for (const r of rows) out[r.program_id] = r.name || null;
    return out;
  } catch (e) {
    console.error('could not read sonar.programs (auditing registry.json only):', e.message);
    return {};
  } finally {
    await pool.end().catch(() => {});
  }
}

// ── table rendering ──────────────────────────────────────────
const VERDICT_ORDER = { MISMATCH: 0, UNREADABLE: 1, MATCH: 2, NO_IDL: 3 };

function pad(s, n) {
  s = s == null ? '' : String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printTable(results) {
  const nameW = Math.min(
    28,
    Math.max(13, ...results.map((r) => (r.registryName || '(unnamed)').length)),
  );
  const idlW = Math.min(
    28,
    Math.max(8, ...results.map((r) => (r.idlName || '—').length)),
  );

  const header = `${pad('program_id', 44)}  ${pad('registry name', nameW)}  ${pad('IDL name', idlW)}  verdict`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    const rn = r.registryName || '(unnamed)';
    const inm = r.verdict === 'UNREADABLE' ? '(unreadable)' : (r.idlName || '—');
    console.log(`${pad(r.id, 44)}  ${pad(rn, nameW)}  ${pad(inm, idlW)}  ${r.verdict}`);
  }
}

// ── main ─────────────────────────────────────────────────────
async function main() {
  const reg = readRegistry();
  const db = await readDbPrograms();

  // Union of ids; registry name wins over the DB name when both exist.
  const ids = new Set([...Object.keys(reg), ...Object.keys(db)]);
  const targets = [...ids].map((id) => ({
    id,
    registryName: reg[id] != null ? reg[id] : (db[id] != null ? db[id] : null),
  }));

  console.error(`Auditing ${targets.length} program(s) (${Object.keys(reg).length} registry + ${Object.keys(db).length} sonar.programs, unioned) against ${RPC}\n`);

  const results = [];
  for (const t of targets) {
    const r = await auditProgram(t.id, t.registryName);
    results.push(r);
    if (r.note) console.error(`  note ${r.id}: ${r.note}`);
  }

  // Mismatches first, then unreadable, then matches, then no-IDL. Within a
  // verdict, sort by registry name for a stable, scannable table.
  results.sort((a, b) => {
    const d = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
    if (d !== 0) return d;
    return String(a.registryName || '').localeCompare(String(b.registryName || ''));
  });

  console.log('');
  printTable(results);

  const counts = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
  console.log('');
  console.log(
    `Summary: ${counts.MATCH || 0} MATCH · ${counts.MISMATCH || 0} MISMATCH · ` +
    `${counts.UNREADABLE || 0} UNREADABLE · ${counts.NO_IDL || 0} NO_IDL ` +
    `(${results.length} total)`,
  );
}

main().catch((e) => {
  console.error('idl-audit crashed:', e && e.message);
  process.exit(1);
});

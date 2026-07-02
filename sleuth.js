// X1 Sonar — sleuth.js
// Evidence gatherer for unidentified programs. For each target it reports:
//   1. Loader/ownership, upgrade authority, program lock state, deploy slot
//   2. Printable strings extracted from the program bytecode
//      (error messages, instruction names, URLs — the GENESIS technique)
//   3. Recent transactions: logged instruction names, CPI partner programs
//   4. Top signers + success split from Sonar's own interactions table
//   5. Likely deployer (fee payer of oldest known signature)
//
// Usage:
//   node sleuth.js <PROGRAM_ID>          one program
//   node sleuth.js --all-unknown         every category='Unknown' program in the DB
//
// Read-only everywhere. Throttled ~250ms/RPC call (validator-safe).

require('dotenv').config();
const { Pool } = require('pg');

const RPC = process.env.X1_RPC_URL || 'http://localhost:8899';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = 250;

let rpcId = 0;
async function rpc(method, params) {
  await sleep(PACE);
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// ── base58 (no deps) ─────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

function extractStrings(buf, min = 6) {
  const out = [];
  let cur = [];
  for (const b of buf) {
    if (b >= 0x20 && b <= 0x7e) cur.push(b);
    else {
      if (cur.length >= min) out.push(Buffer.from(cur).toString());
      cur = [];
    }
  }
  if (cur.length >= min) out.push(Buffer.from(cur).toString());
  return out;
}

const INTERESTING = /error|fail|insufficient|invalid|unauthorized|overflow|exceed|already|not allowed|mint|burn|swap|stake|unstake|delegate|claim|deposit|withdraw|transfer|pool|vault|oracle|feed|price|game|play|bet|wager|reward|lottery|nft|edition|collection|metadata|auction|list|buy|sell|royalt|bridge|wrap|instruction|initialize|anchor|src\/|\.rs|http|\.com|\.xyz|\.io/i;

async function investigate(programId) {
  console.log('\n' + '═'.repeat(66));
  console.log(`◎ ${programId}`);
  console.log('═'.repeat(66));

  // 1 ── ownership / loader / programdata
  const acct = await rpc('getAccountInfo', [programId, { encoding: 'base64' }]);
  if (!acct || !acct.value) { console.log('  ✗ account not found'); return; }
  const owner = acct.value.owner;
  console.log(`  owner (loader): ${owner}${acct.value.executable ? '' : '  ⚠ NOT EXECUTABLE'}`);

  let bytecode = null;
  if (owner === UPGRADEABLE_LOADER) {
    const progBuf = Buffer.from(acct.value.data[0], 'base64');
    // Program account layout: enum tag u32 (=2) + programdata pubkey
    const programData = b58encode(progBuf.subarray(4, 36));
    console.log(`  programdata:    ${programData}`);
    const pd = await rpc('getAccountInfo', [programData, { encoding: 'base64' }]);
    if (pd && pd.value) {
      const buf = Buffer.from(pd.value.data[0], 'base64');
      // ProgramData layout: tag u32 + deploy_slot u64 + option u8 + authority 32
      const deploySlot = buf.readBigUInt64LE(4);
      const hasAuth = buf[12] === 1;
      console.log(`  deployed slot:  ${deploySlot}`);
      if (hasAuth) {
        console.log(`  upgrade auth:   ${b58encode(buf.subarray(13, 45))}  (UPGRADEABLE)`);
      } else {
        console.log('  upgrade auth:   NONE — program is LOCKED (immutable)');
      }
      bytecode = buf.subarray(45);
    }
  } else {
    bytecode = Buffer.from(acct.value.data[0], 'base64');
  }

  // 2 ── bytecode strings
  if (bytecode && bytecode.length) {
    const strings = extractStrings(bytecode)
      .filter((s) => INTERESTING.test(s))
      .filter((s, i, a) => a.indexOf(s) === i)
      .slice(0, 40);
    console.log(`\n  ── bytecode strings (${bytecode.length.toLocaleString()} bytes, top matches) ──`);
    if (strings.length === 0) console.log('  (no readable matches — possibly stripped/compressed)');
    for (const s of strings) console.log(`   · ${s.slice(0, 100)}`);
  }

  // 3 ── recent transactions: instruction names + CPI partners
  const sigs = await rpc('getSignaturesForAddress', [programId, { limit: 25 }]);
  console.log(`\n  ── recent activity (${sigs.length} sigs sampled) ──`);
  const ixNames = new Map();
  const partners = new Map();
  const sampled = sigs.slice(0, 8);
  for (const s of sampled) {
    const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
    if (!tx) continue;
    for (const log of tx.meta?.logMessages || []) {
      const m = log.match(/Program log: Instruction: (\w+)/);
      if (m) ixNames.set(m[1], (ixNames.get(m[1]) || 0) + 1);
      const inv = log.match(/Program (\w{32,44}) invoke/);
      if (inv && inv[1] !== programId) partners.set(inv[1], (partners.get(inv[1]) || 0) + 1);
    }
  }
  if (ixNames.size) {
    console.log('  instructions seen in logs:');
    for (const [n, c] of [...ixNames].sort((a, b) => b[1] - a[1])) console.log(`   · ${n}  ×${c}`);
  } else {
    console.log('  (no named instructions in logs — non-Anchor or silent program)');
  }
  if (partners.size) {
    console.log('  co-invoked programs (CPI partners):');
    for (const [p, c] of [...partners].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`   · ${p}  ×${c}`);
  }

  // 4 ── Sonar's own data: top signers + success split
  const top = await pool.query(
    `SELECT signer, COUNT(*) n, COUNT(*) FILTER (WHERE success) ok
     FROM sonar.interactions WHERE program_id = $1
     GROUP BY signer ORDER BY n DESC LIMIT 8`,
    [programId]
  );
  console.log('\n  ── top signers (from Sonar index) ──');
  for (const r of top.rows) {
    console.log(`   · ${r.signer}  ${r.n} txs (${r.ok} ok / ${r.n - r.ok} failed)`);
  }
  const conc = top.rows.length
    ? Number(top.rows[0].n) / top.rows.reduce((s, r) => s + Number(r.n), 0)
    : 0;
  if (top.rows.length > 3 && conc < 0.5) console.log('  → many distinct signers: looks like a real multi-user app');
  else if (conc >= 0.8) console.log('  → single dominant signer: bot / oracle-updater / operator pattern');

  // 5 ── likely deployer: fee payer of the oldest signature we can see
  const oldest = sigs[sigs.length - 1];
  if (oldest) {
    const tx = await rpc('getTransaction', [oldest.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
    const payer = tx?.transaction?.message?.accountKeys?.[0];
    if (payer) console.log(`\n  oldest sampled tx fee payer: ${payer}`);
    console.log('  (for the true deployer, walk getSignaturesForAddress with `before` to the first tx)');
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node sleuth.js <PROGRAM_ID> | --all-unknown');
    process.exit(1);
  }
  let targets = [];
  if (arg === '--all-unknown') {
    const { rows } = await pool.query(
      `SELECT program_id FROM sonar.programs WHERE category = 'Unknown' ORDER BY sonar_score DESC`
    );
    targets = rows.map((r) => r.program_id);
    console.log(`Investigating ${targets.length} unknown programs…`);
  } else {
    targets = [arg];
  }
  for (const t of targets) {
    try { await investigate(t); }
    catch (e) { console.error(`  ✗ ${t}: ${e.message}`); }
  }
  await pool.end();
}

main();

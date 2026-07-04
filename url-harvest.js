// X1 Sonar — url-harvest.js
// Scans ALL programs in the database for URLs embedded in their bytecode
// (security.txt declarations, project links, source repos). Outputs a
// candidate list: program → URLs found. NOTHING is auto-written to the
// registry — human reviews and approves. A program can embed any URL it
// wants, including scams, so provenance is "self-declared", not "verified".
//
// Read-only. Usage: node url-harvest.js

require('dotenv').config();
const { Client } = require('pg');

const RPC = process.env.X1_RPC_URL || 'http://localhost:8899';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// Extract printable-ASCII runs, then URLs out of those
function extractUrls(buf) {
  const urls = new Set();
  let run = [];
  const flush = () => {
    if (run.length >= 8) {
      const s = run.join('');
      const re = /https?:\/\/[A-Za-z0-9._\-\/#?=&%+~:@]+/g;
      let m;
      while ((m = re.exec(s)) !== null) {
        let u = m[0].replace(/[.,)\]}'"]+$/, ''); // trim trailing junk
        urls.add(u);
      }
    }
    run = [];
  };
  for (const b of buf) {
    if (b >= 0x20 && b <= 0x7e) run.push(String.fromCharCode(b));
    else flush();
  }
  flush();
  return [...urls];
}

// Noise URLs that appear in almost every program (toolchain, stdlib, etc.)
const NOISE = [
  'github.com/anza-xyz/llvm-project',
  'github.com/rust-lang',
  'crates.io',
  'docs.rs',
  'invalid.',
  'w3.org',
  'apache.org/licenses',
  'opensource.org',
];
function isNoise(u) {
  return NOISE.some((n) => u.includes(n));
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query(
    `SELECT program_id, COALESCE(name, '(unnamed)') AS name FROM sonar.programs ORDER BY name`
  );
  await db.end();

  console.log(`Scanning ${rows.length} programs for embedded URLs…\n`);
  const findings = [];

  for (const { program_id, name } of rows) {
    // resolve programdata for upgradeable programs (bytecode lives there)
    let dataAccount = program_id;
    try {
      const info = await rpc('getAccountInfo', [program_id, { encoding: 'base64' }]);
      if (!info?.value) continue;
      const buf = Buffer.from(info.value.data[0], 'base64');
      // Upgradeable loader program account: 4-byte enum(2) + programdata pubkey at offset 4
      if (info.value.owner === 'BPFLoaderUpgradeab1e11111111111111111111111' && buf.length >= 36) {
        const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let n = 0n;
        for (const byte of buf.subarray(4, 36)) n = n * 256n + BigInt(byte);
        let s = '';
        while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
        for (const byte of buf.subarray(4, 36)) { if (byte === 0) s = '1' + s; else break; }
        dataAccount = s;
      }
      await sleep(80);
      const target = dataAccount === program_id ? buf : Buffer.from(
        (await rpc('getAccountInfo', [dataAccount, { encoding: 'base64' }])).value.data[0], 'base64'
      );
      const urls = extractUrls(target).filter((u) => !isNoise(u));
      if (urls.length) findings.push({ name, program_id, urls });
      await sleep(80);
    } catch (e) { /* native programs etc — skip quietly */ }
  }

  console.log('═'.repeat(66));
  console.log('CANDIDATE URLS (self-declared in bytecode — REVIEW before registry)');
  console.log('═'.repeat(66));
  for (const f of findings) {
    console.log(`\n◎ ${f.name}  (${f.program_id.slice(0, 8)}…)`);
    for (const u of f.urls.slice(0, 6)) console.log(`   ${u}`);
  }
  console.log(`\n${findings.length} programs had non-noise URLs.`);
  console.log('Approve the good ones into registry.json "website" fields manually.');
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });

// X1 Sonar — txinspect.js
// Deep per-transaction analysis for a program. For a sample of recent txs it shows:
//   · which accounts the program touched and their roles (signer/writable)
//   · the first-byte instruction discriminator (tells variants apart)
//   · every OTHER program invoked in the same tx (the real tell:
//     a validator stake pool CPIs into Stake11111... and System)
//   · full program-log trace
//
// Read-only. Usage: node txinspect.js <PROGRAM_ID> [numTx=5]

require('dotenv').config();

const RPC = process.env.X1_RPC_URL || 'http://localhost:8899';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Well-known native/infra program IDs → human names, so CPI targets read clearly
const KNOWN = {
  'Stake11111111111111111111111111111111111111': 'Stake Program (native)',
  '11111111111111111111111111111111': 'System Program',
  'Vote111111111111111111111111111111111111111': 'Vote Program',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'SPL Token',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token Account',
  'SysvarC1ock11111111111111111111111111111111': 'Clock Sysvar',
  'SysvarStakeHistory1111111111111111111111111': 'StakeHistory Sysvar',
  'SysvarRent111111111111111111111111111111111': 'Rent Sysvar',
  'StakeConfig11111111111111111111111111111111': 'StakeConfig',
  'ComputeBudget111111111111111111111111111111': 'ComputeBudget',
};

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

function name(id) { return KNOWN[id] ? `${KNOWN[id]}` : id; }

async function main() {
  const programId = process.argv[2];
  const N = parseInt(process.argv[3] || '5', 10);
  if (!programId) { console.error('usage: node txinspect.js <PROGRAM_ID> [numTx]'); process.exit(1); }

  console.log(`\nDeep-inspecting ${N} transactions for:\n  ${programId}\n`);

  const sigs = await rpc('getSignaturesForAddress', [programId, { limit: N }]);
  const cpiTally = new Map();

  for (const [i, s] of sigs.entries()) {
    await sleep(150);
    const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
    if (!tx) continue;

    console.log('─'.repeat(64));
    console.log(`TX ${i + 1}: ${s.signature.slice(0, 24)}…  ${tx.meta?.err ? '✗ FAILED' : '✓ ok'}`);

    // Top-level instructions that target THIS program, + all invoked programs
    const msg = tx.transaction.message;
    const ixs = msg.instructions || [];
    const involvedPrograms = new Set();

    for (const ix of ixs) {
      const pid = ix.programId;
      involvedPrograms.add(pid);
      if (pid === programId) {
        // our program's instruction — show account count + raw data head
        const dataHead = ix.data ? ix.data.slice(0, 16) : '(parsed)';
        console.log(`  ▸ calls target program · ${ix.accounts ? ix.accounts.length : '?'} accounts · data[0..]: ${dataHead}`);
      }
    }

    // Inner instructions reveal CPIs (the decisive evidence)
    for (const inner of tx.meta?.innerInstructions || []) {
      for (const ix of inner.instructions) {
        if (ix.programId) involvedPrograms.add(ix.programId);
      }
    }

    // Program logs — where "invoke" lines name every CPI target
    const invoked = new Set();
    for (const log of tx.meta?.logMessages || []) {
      const m = log.match(/Program (\w{32,44}) invoke/);
      if (m) invoked.add(m[1]);
    }
    for (const p of invoked) involvedPrograms.add(p);

    // Report the programs touched, named
    const others = [...involvedPrograms].filter((p) => p !== programId && !KNOWN[p] === false ? true : p !== programId);
    const namedOthers = [...involvedPrograms].filter((p) => p !== programId);
    if (namedOthers.length) {
      console.log('    co-programs in this tx:');
      for (const p of namedOthers) {
        console.log(`      → ${name(p)}`);
        cpiTally.set(p, (cpiTally.get(p) || 0) + 1);
      }
    }
  }

  console.log('\n' + '═'.repeat(64));
  console.log('CO-PROGRAM TALLY (across sampled txs) — the identity fingerprint:');
  for (const [p, c] of [...cpiTally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(3)}×  ${name(p)}`);
  }
  console.log('\nInterpretation:');
  console.log('  · Heavy Stake Program + StakeHistory/Clock sysvars → VALIDATOR staking (SPL Stake Pool)');
  console.log('  · Heavy SPL Token + no Stake Program → token-only app (DEX / token-staking / mint)');
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });

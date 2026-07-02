// Verifies extractInteractions against a mock block:
//  - vote tx is filtered out entirely
//  - ComputeBudget instruction is skipped but the real program in the same tx is kept
//  - same program hit twice in one tx counts once
//  - program id living in loadedAddresses (v0 tx) is resolved
//  - failed tx gets success=false
const assert = require('assert');
const { extractInteractions } = require('./indexer.js');

const VOTE = 'Vote111111111111111111111111111111111111111';
const CB = 'ComputeBudget111111111111111111111111111111';
const DEX = '9yCbdExJXtxexpdEXAcmgGqTnPN4apJbhjZscS8ntk4j';
const ORACLE = '9mPmjK8NxJadYDiHiYAQH4WFCZ8kr7ZV8ria63ZkMtv2';
const SIGNER = '59KYnuMGduACCrCsydDZYm3HwPnrc1v5Qm1bVkF75uQe';

function tx(sig, keys, ixProgramIndexes, { err = null, loaded = null } = {}) {
  return {
    transaction: {
      signatures: [sig],
      message: {
        staticAccountKeys: keys,
        compiledInstructions: ixProgramIndexes.map((i) => ({ programIdIndex: i })),
      },
    },
    meta: { err, loadedAddresses: loaded },
  };
}

const block = {
  blockTime: 1782950400,
  transactions: [
    // 1. pure vote tx → nothing indexed
    tx('sig_vote', [SIGNER, VOTE], [1]),
    // 2. ComputeBudget + DEX called twice → exactly one DEX row
    tx('sig_dex', [SIGNER, CB, DEX], [1, 2, 2]),
    // 3. v0 tx: oracle program id arrives via loadedAddresses, tx failed
    tx('sig_v0', [SIGNER], [1], { err: { InstructionError: [0, 'Custom'] }, loaded: { writable: [], readonly: [ORACLE] } }),
  ],
};

const rows = extractInteractions(block, 12345);

assert.strictEqual(rows.length, 2, `expected 2 rows, got ${rows.length}`);

const dexRow = rows.find((r) => r.programId === DEX);
assert.ok(dexRow, 'DEX row missing');
assert.strictEqual(dexRow.success, true);
assert.strictEqual(dexRow.signer, SIGNER);
assert.strictEqual(dexRow.slot, 12345);

const oracleRow = rows.find((r) => r.programId === ORACLE);
assert.ok(oracleRow, 'loaded-address program not resolved');
assert.strictEqual(oracleRow.success, false, 'failed tx should be success=false');

assert.ok(!rows.some((r) => r.programId === VOTE), 'vote leaked through');
assert.ok(!rows.some((r) => r.programId === CB), 'ComputeBudget leaked through');

assert.strictEqual(rows[0].ts.toISOString(), '2026-07-02T00:00:00.000Z');

console.log('✓ all extraction checks passed');
console.log(JSON.stringify(rows, null, 2));

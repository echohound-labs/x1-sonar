// End-to-end DB test: writeBatch as the indexer role, verify upserts + dedupe
process.env.DATABASE_URL = 'postgresql://indexer:testpass@localhost:5432/echohound';
process.env.X1_RPC_URL = 'http://localhost:9999'; // unused here
const assert = require('assert');
const { Pool } = require('pg');

async function run() {
  // import after env set
  delete require.cache[require.resolve('./indexer.js')];
  const idx = require('./indexer.js');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const DEX = '9yCbdExJXtxexpdEXAcmgGqTnPN4apJbhjZscS8ntk4j';
  const now = new Date();
  const rows = [
    { programId: DEX, signature: 'sigA', slot: 100, signer: 'W1', success: true, ts: now },
    { programId: DEX, signature: 'sigB', slot: 101, signer: 'W2', success: true, ts: now },
  ];

  // writeBatch isn't exported — exercise it via the same SQL path by requiring internals?
  // It IS module-scoped; test through a re-export shim instead:
  const { writeBatchForTest } = idx;
  assert.ok(writeBatchForTest, 'writeBatch not exported for test');

  await writeBatchForTest(rows);
  await writeBatchForTest(rows); // replay same batch — dedupe must hold

  const p = await pool.query('SELECT tx_count_all, first_seen_slot FROM sonar.programs WHERE program_id=$1', [DEX]);
  assert.strictEqual(Number(p.rows[0].tx_count_all), 2, 'replay double-counted!');
  assert.strictEqual(Number(p.rows[0].first_seen_slot), 100);

  const i = await pool.query('SELECT COUNT(*) FROM sonar.interactions');
  assert.strictEqual(Number(i.rows[0].count), 2);

  console.log('✓ writeBatch as indexer role: inserts OK, replay-safe (no double counting)');
  await pool.end();
  process.exit(0);
}
run().catch((e) => { console.error('✗', e.message); process.exit(1); });

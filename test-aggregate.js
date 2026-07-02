// End-to-end aggregator test with seeded data covering the edge cases:
//  - active program (recent txs, mixed success)
//  - stale program with old nonzero counts (must reset to 0)
//  - >30-day-old program (age bonus 1.0)
//  - rows older than retention (must be pruned)
//  - daily_stats replay safety (run twice, same result)
process.env.DATABASE_URL = 'postgresql://indexer:testpass@localhost:5432/echohound';
const assert = require('assert');
const { aggregate, pool } = require('./aggregate.js');

const HOT = 'HotProgram111111111111111111111111111111111';
const STALE = 'StaleProgram1111111111111111111111111111111';
const OLD = 'OldProgram111111111111111111111111111111111';

async function seed() {
  for (const t of ['interactions','daily_stats','programs','checkpoint']) await pool.query(`DELETE FROM sonar.${t}`);
  // HOT: first seen 3 days ago, 4 recent txs (3 ok / 1 fail), 2 signers
  await pool.query(`INSERT INTO sonar.programs (program_id, first_seen_at, last_active_at) VALUES
    ($1, NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 hour'),
    ($2, NOW() - INTERVAL '60 days', NOW() - INTERVAL '20 days'),
    ($3, NOW() - INTERVAL '45 days', NOW() - INTERVAL '2 hours')`, [HOT, STALE, OLD]);
  // stale program starts with bogus nonzero window counts that MUST reset
  await pool.query(`UPDATE sonar.programs SET tx_count_24h=999, tx_count_7d=999 WHERE program_id=$1`, [STALE]);

  const ins = `INSERT INTO sonar.interactions (program_id, signature, slot, signer, success, ts) VALUES ($1,$2,$3,$4,$5,$6)`;
  await pool.query(ins, [HOT, 'h1', 1, 'W1', true,  new Date(Date.now() - 3600e3)]);
  await pool.query(ins, [HOT, 'h2', 2, 'W1', true,  new Date(Date.now() - 7200e3)]);
  await pool.query(ins, [HOT, 'h3', 3, 'W2', true,  new Date(Date.now() - 2 * 86400e3)]); // 7d window only
  await pool.query(ins, [HOT, 'h4', 4, 'W2', false, new Date(Date.now() - 3600e3)]);
  await pool.query(ins, [OLD, 'o1', 5, 'W3', true,  new Date(Date.now() - 7200e3)]);
  // ancient row → must be pruned
  await pool.query(ins, [HOT, 'ancient', 6, 'W1', true, new Date(Date.now() - 10 * 86400e3)]);
}

async function run() {
  await seed();
  await aggregate();
  await aggregate(); // replay — must be idempotent

  const { rows } = await pool.query(
    `SELECT program_id, tx_count_24h, tx_count_7d, unique_signers_7d, success_rate_24h, sonar_score
     FROM sonar.programs ORDER BY sonar_score DESC`);
  const by = Object.fromEntries(rows.map(r => [r.program_id, r]));

  // HOT: 24h = h1,h2,h4 (3); 7d = +h3 (4); signers 7d = 2; success 24h = 2/3
  assert.strictEqual(Number(by[HOT].tx_count_24h), 3);
  assert.strictEqual(Number(by[HOT].tx_count_7d), 4);
  assert.strictEqual(Number(by[HOT].unique_signers_7d), 2);
  assert.ok(Math.abs(by[HOT].success_rate_24h - 2 / 3) < 0.01, 'success rate wrong');

  // STALE: bogus 999s reset to 0, but tx_count_all-style identity intact
  assert.strictEqual(Number(by[STALE].tx_count_24h), 0, 'stale 24h not reset');
  assert.strictEqual(Number(by[STALE].tx_count_7d), 0, 'stale 7d not reset');

  // Scores: HOT (max activity) > OLD (1 tx) > STALE (nothing recent)
  assert.strictEqual(rows[0].program_id, HOT, 'HOT should rank #1');
  assert.strictEqual(rows[2].program_id, STALE, 'STALE should rank last');
  assert.ok(by[HOT].sonar_score > 0 && by[HOT].sonar_score <= 1000);

  // Prune: ancient row gone, recent rows kept (6 seeded - 1 pruned = 5)
  const n = await pool.query('SELECT COUNT(*) FROM sonar.interactions');
  assert.strictEqual(Number(n.rows[0].count), 5, 'prune wrong');

  // daily_stats exists for HOT today and is replay-stable
  const ds = await pool.query(`SELECT tx_count FROM sonar.daily_stats WHERE program_id=$1 AND date=CURRENT_DATE`, [HOT]);
  assert.strictEqual(Number(ds.rows[0].tx_count), 3);

  console.log('✓ aggregator: windows, reset, score ranking, success rate, prune, replay — all pass');
  console.log(rows.map(r => `${r.program_id.slice(0, 12)}…  score=${r.sonar_score}  24h=${r.tx_count_24h}  7d=${r.tx_count_7d}`).join('\n'));
  await pool.end();
}
run().catch((e) => { console.error('✗', e.message); process.exit(1); });

// X1 Sonar — apply-pending.js
// Merge pending-registry.json (populated by sonar-watch.js approvals) into BOTH
// registry.json and dashboard/registry.json, print the additions, then clear
// pending. Run manually after approving programs in Telegram:
//
//   node apply-pending.js
//
// All writes are atomic (write .tmp, then rename over the target) so a crash
// mid-write never corrupts a registry or the pending file.

const fs = require('fs');
const path = require('path');

const PENDING_FILE = path.join(__dirname, 'pending-registry.json');
const REGISTRIES = [
  path.join(__dirname, 'registry.json'),
  path.join(__dirname, 'dashboard', 'registry.json'),
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function main() {
  const pending = readJson(PENDING_FILE, null);
  if (!pending || typeof pending !== 'object') {
    console.log('No pending-registry.json (or unreadable) — nothing to apply.');
    return;
  }
  const entries = Object.entries(pending).filter(([k]) => !k.startsWith('_'));
  if (!entries.length) {
    console.log('pending-registry.json is empty — nothing to apply.');
    return;
  }

  // Compute additions relative to the primary registry (they stay in lockstep).
  const primary = readJson(REGISTRIES[0], {});
  const additions = entries.filter(([id]) => !primary[id]);
  const already = entries.filter(([id]) => primary[id]);

  for (const file of REGISTRIES) {
    const reg = readJson(file, {});
    for (const [id, meta] of entries) reg[id] = meta;
    writeJsonAtomic(file, reg);
    console.log(`updated ${path.relative(__dirname, file)}`);
  }

  console.log('\nAdditions:');
  if (!additions.length) console.log('  (none — all pending entries already present)');
  for (const [id, meta] of additions) {
    console.log(`  + ${meta.name} — ${meta.category}${meta.website ? `  (${meta.website})` : ''}`);
    console.log(`    ${id}`);
  }
  if (already.length) {
    console.log(`\n${already.length} pending entr${already.length === 1 ? 'y' : 'ies'} already in registry (overwritten in place).`);
  }

  // Clear pending only after both registries were written.
  writeJsonAtomic(PENDING_FILE, {});
  console.log('\nCleared pending-registry.json.');
  console.log(`Applied ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${additions.length} new).`);
}

main();

// X1 Sonar — sonar-watch.js
// A dependency-light Telegram bot (Node + pg + dotenv only; no bot framework).
// Long-polling, no webhook. Three features:
//
//   1. NEW-PROGRAM APPROVAL FLOW (admin only, every 10 min)
//      Find sonar.programs rows not in registry.json and not already tracked in
//      watch-state.json. Gather sleuth-style evidence (bytecode strings incl.
//      programdata resolution, security.txt, URLs, instruction names), DM the
//      admin a proposal with ✅ Approve / ❌ Skip buttons. Approve appends to
//      pending-registry.json (NEVER registry.json) and reminds to run backfill.
//      Reply "Name | Category" to a proposal to override + approve.
//
//   2. DAILY TOP-10 LEADERBOARD (to SONAR_CHANNEL, once daily at SONAR_POST_HOUR)
//      Top 10 by sonar_score, apps-only (infrastructure excluded, like the
//      dashboard). Movement arrows vs the previous post (stored in state).
//
//   3. /top COMMAND (open to anyone) — same current top-10, live from the DB.
//
// Robustness: never crashes on RPC/Telegram/DB errors — logs and continues.
// All writes to watch-state.json / pending-registry.json are atomic
// (write .tmp, then rename over the target).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');

// ── config ───────────────────────────────────────────────────
const TOKEN = process.env.SONAR_BOT_TOKEN;
const ADMIN = process.env.SONAR_ADMIN_CHAT;
const CHANNEL = process.env.SONAR_CHANNEL || ADMIN;
const DB_URL = process.env.DATABASE_URL;
const RPC = process.env.X1_RPC_URL || 'http://localhost:8899';
const POST_HOUR = parseInt(process.env.SONAR_POST_HOUR || '15', 10);

const SCAN_INTERVAL_MS = 10 * 60 * 1000; // approval scan cadence
const PROPOSALS_PER_CYCLE = 5;           // cap per scan to avoid flooding
const POLL_TIMEOUT = 50;                 // getUpdates long-poll seconds
const RPC_PACE_MS = 250;                 // validator-safe throttle

const STATE_FILE = path.join(__dirname, 'watch-state.json');
const PENDING_FILE = path.join(__dirname, 'pending-registry.json');
const REGISTRY_FILE = path.join(__dirname, 'registry.json');

const API = `https://api.telegram.org/bot${TOKEN}`;
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

// The public channel layer is active only when SONAR_CHANNEL is set AND is a
// different chat from the admin. Otherwise the "channel" IS the admin DM and we
// must not double-post there.
const CHANNEL_IS_PUBLIC = !!CHANNEL && String(CHANNEL) !== String(ADMIN);
const DOC_THRESHOLD = 3500; // pending JSON longer than this goes as a document

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!TOKEN || !ADMIN || !DB_URL) {
  console.error('FATAL: SONAR_BOT_TOKEN, SONAR_ADMIN_CHAT and DATABASE_URL are required in .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL });

// ── atomic JSON I/O ──────────────────────────────────────────
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
  fs.renameSync(tmp, file); // atomic on the same filesystem
}

// In-memory state, persisted atomically after every mutation batch.
let state = readJson(STATE_FILE, null) || {
  offset: 0,
  programs: {},   // programId -> { status, proposedAt, messageId, suggested, approved }
  proposals: {},  // messageId  -> programId (for "Name | Category" replies)
  board: null,    // { messageId, date, top: [{program_id,name,score}] } — the pinned live leaderboard
};
// Migrate the pre-pinned-board shape (lastPost had no messageId): keep its top
// as the movement baseline; the missing messageId forces a fresh post + pin.
if (state.lastPost && !state.board) {
  state.board = { messageId: null, date: null, top: state.lastPost.top };
}
delete state.lastPost;
function saveState() {
  try {
    writeJsonAtomic(STATE_FILE, state);
  } catch (e) {
    log('saveState failed:', e.message);
  }
}

// ── Telegram API ─────────────────────────────────────────────
// tgCall returns the raw parsed response ({ ok, result } or { ok:false,
// description }), or null on a network-level failure — callers that need to
// inspect the error (e.g. "message to edit not found") use this.
async function tgCall(method, body, timeoutMs = 15000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return await res.json();
  } catch (e) {
    log(`tg ${method} failed:`, e.message);
    return null;
  }
}

// tg is the convenience wrapper: returns result on success, null on any failure
// (logging the error). Never throws.
async function tg(method, body, timeoutMs = 15000) {
  const j = await tgCall(method, body, timeoutMs);
  if (!j) return null;
  if (!j.ok) {
    log(`tg ${method} error:`, j.description);
    return null;
  }
  return j.result;
}

// Upload a text file via sendDocument (multipart). Never throws; null on fail.
async function tgDocument(chatId, filename, content, caption) {
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([content], { type: 'application/json' }), filename);
    const res = await fetch(`${API}/sendDocument`, { method: 'POST', body: form });
    const j = await res.json();
    if (!j.ok) { log('tg sendDocument error:', j.description); return null; }
    return j.result;
  } catch (e) {
    log('tg sendDocument failed:', e.message);
    return null;
  }
}

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
    log(`rpc ${method} failed:`, e.message);
    return null;
  }
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

// ── evidence gathering (sleuth.js / url-harvest.js technique) ─
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

function extractUrls(buf) {
  const urls = new Set();
  let run = [];
  const flush = () => {
    if (run.length >= 8) {
      const s = run.join('');
      const re = /https?:\/\/[A-Za-z0-9._\-\/#?=&%+~:@]+/g;
      let m;
      while ((m = re.exec(s)) !== null) {
        urls.add(m[0].replace(/[.,)\]}'"]+$/, ''));
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

const NOISE = [
  'github.com/anza-xyz/llvm-project', 'github.com/rust-lang', 'crates.io',
  'docs.rs', 'invalid.', 'w3.org', 'apache.org/licenses', 'opensource.org',
];
const isNoise = (u) => NOISE.some((n) => u.includes(n));

// security.txt is embedded as a run of key/value strings between markers.
// extractStrings splits key and value into separate runs, so they alternate.
const SEC_KEYS = [
  'name', 'project_url', 'contacts', 'policy', 'preferred_languages',
  'encryption', 'source_code', 'source_release', 'source_revision',
  'auditors', 'acknowledgements', 'expiry',
];
function parseSecurityTxt(strings) {
  const begin = strings.findIndex((s) => /BEGIN SECURITY\.TXT/i.test(s));
  if (begin < 0) return {};
  const out = {};
  const slice = strings.slice(begin + 1);
  for (let i = 0; i < slice.length; i++) {
    if (/END SECURITY\.TXT/i.test(slice[i])) break;
    const k = slice[i].trim().toLowerCase();
    if (SEC_KEYS.includes(k) && slice[i + 1]) out[k] = slice[i + 1].trim();
  }
  return out;
}

async function gatherEvidence(id) {
  const ev = { strings: [], urls: [], security: {}, ixNames: [], locked: null };
  const acct = await rpc('getAccountInfo', [id, { encoding: 'base64' }]);
  if (!acct || !acct.value) return ev;

  let bytecode = null;
  if (acct.value.owner === UPGRADEABLE_LOADER) {
    const progBuf = Buffer.from(acct.value.data[0], 'base64');
    const programData = b58encode(progBuf.subarray(4, 36));
    const pd = await rpc('getAccountInfo', [programData, { encoding: 'base64' }]);
    if (pd && pd.value) {
      const buf = Buffer.from(pd.value.data[0], 'base64');
      ev.locked = buf[12] !== 1; // option byte 0 => no authority => locked
      bytecode = buf.subarray(45);
    }
  } else {
    bytecode = Buffer.from(acct.value.data[0], 'base64');
  }

  if (bytecode && bytecode.length) {
    const all = extractStrings(bytecode);
    ev.strings = all
      .filter((s) => INTERESTING.test(s))
      .filter((s, i, a) => a.indexOf(s) === i)
      .slice(0, 40);
    ev.urls = extractUrls(bytecode).filter((u) => !isNoise(u)).slice(0, 10);
    ev.security = parseSecurityTxt(all);
  }

  const sigs = (await rpc('getSignaturesForAddress', [id, { limit: 25 }])) || [];
  const ix = new Map();
  for (const s of sigs.slice(0, 8)) {
    const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
    if (!tx) continue;
    for (const lg of tx.meta?.logMessages || []) {
      const m = lg.match(/Program log: Instruction: (\w+)/);
      if (m) ix.set(m[1], (ix.get(m[1]) || 0) + 1);
    }
  }
  ev.ixNames = [...ix].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  return ev;
}

// ── suggestion heuristics ────────────────────────────────────
function titleCase(s) {
  return s.replace(/[_\-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
function domainName(url) {
  try {
    const host = url.replace(/^https?:\/\//, '').split(/[\/?#]/)[0];
    const label = host.replace(/^www\./, '').split('.')[0];
    return titleCase(label);
  } catch (e) {
    return null;
  }
}

const CATEGORY_RULES = [
  [/swap|liquid|amm|\brouter?\b|twap|\bdex\b|orderbook/i, 'DEX'],
  [/unstake|\bstake\b|delegate|validator|\bfarm\b|reward/i, 'Staking'],
  [/\bnft\b|metadata|edition|collection|royalt|mint.?nft/i, 'NFT'],
  [/bridge|\bwrap\b|relay|cross.?chain/i, 'Bridge'],
  [/\bgame\b|\bplay\b|\bbet\b|wager|lottery|battle|arena/i, 'Game'],
  [/market|listing|auction|escrow/i, 'Marketplace'],
  [/oracle|price.?feed|\bfeed\b/i, 'Oracle'],
  [/mint|burn|\btoken\b|transfer/i, 'Token'],
];

function deriveSuggestion(ev) {
  const hay = [
    ev.strings.join(' '), ev.urls.join(' '),
    ev.ixNames.join(' '), Object.values(ev.security).join(' '),
  ].join(' ');

  let category = 'Utility';
  for (const [re, c] of CATEGORY_RULES) {
    if (re.test(hay)) { category = c; break; }
  }

  const website = ev.security.project_url
    || ev.urls.find((u) => !/github|gitlab|bitbucket/i.test(u))
    || null;

  let name = null;
  if (ev.security.name) {
    name = ev.security.name;
  } else if (website) {
    name = domainName(website);
  } else {
    const src = ev.strings.find((s) => /programs\/[a-z0-9_\-]+\/src/i.test(s));
    const m = src && src.match(/programs\/([a-z0-9_\-]+)\//i);
    if (m) name = titleCase(m[1]);
  }
  if (!name) {
    const cap = ev.strings.find((s) => /^[A-Z][A-Za-z0-9 ]{3,30}$/.test(s));
    name = cap || 'Unknown';
  }

  let signals = 0;
  if (Object.keys(ev.security).length) signals += 2;
  if (ev.ixNames.length) signals += 1;
  if (website) signals += 1;
  const confidence = signals >= 3 ? 'High' : signals >= 1 ? 'Medium' : 'Low';

  return { name, category, confidence, website };
}

// ── DB helpers ───────────────────────────────────────────────
async function getProgramRow(id) {
  // tx_all_time / first_tx_at are added by backfill.js; fall back if absent.
  try {
    const { rows } = await pool.query(
      `SELECT first_seen_at, first_tx_at,
              COALESCE(tx_all_time, tx_count_all, 0) AS tx_total
       FROM sonar.programs WHERE program_id = $1`, [id]);
    return rows[0] || null;
  } catch (e) {
    const { rows } = await pool.query(
      `SELECT first_seen_at, tx_count_all AS tx_total
       FROM sonar.programs WHERE program_id = $1`, [id]);
    return rows[0] || null;
  }
}

async function topTen() {
  const { rows } = await pool.query(
    `SELECT program_id, COALESCE(name, '(unnamed)') AS name, sonar_score
     FROM sonar.programs
     WHERE infrastructure IS NOT TRUE
     ORDER BY sonar_score DESC NULLS LAST
     LIMIT 10`);
  return rows;
}

// ── formatting ───────────────────────────────────────────────
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatBoard(rows, prevTop, title, updatedDate) {
  const prev = new Map((prevTop || []).map((p, i) => [p.program_id, i + 1]));
  const hadPrev = prevTop && prevTop.length > 0;
  const lines = rows.map((r, i) => {
    const rank = i + 1;
    let mv = '—';
    if (prev.has(r.program_id)) {
      const d = prev.get(r.program_id) - rank;
      mv = d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '—';
    } else if (hadPrev) {
      mv = 'NEW';
    }
    const name = r.name.length > 18 ? `${r.name.slice(0, 17)}…` : r.name;
    const score = Number(r.sonar_score || 0).toFixed(1);
    return `${String(rank).padStart(2)}. ${name.padEnd(18)} ${score.padStart(6)}  ${mv}`;
  });
  const footer = updatedDate ? `\nupdated ${esc(updatedDate)}` : '';
  return `<b>${esc(title)}</b>\n<pre>${esc(lines.join('\n'))}</pre>\nFull board → x1sonar.xyz${footer}`;
}

const fmtFirstSeen = (row) => (row && row.first_seen_at
  ? new Date(row.first_seen_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  : 'unknown');
const fmtTxTotal = (row) => (row && row.tx_total != null ? Number(row.tx_total).toLocaleString() : '?');

function buildProposal(id, row, ev, sug) {
  const firstSeen = fmtFirstSeen(row);
  const txTotal = fmtTxTotal(row);

  const lines = [];
  if (ev.security.name) lines.push(`security.txt name: ${ev.security.name}`);
  if (ev.security.project_url) lines.push(`security.txt url: ${ev.security.project_url}`);
  if (ev.security.source_code) lines.push(`source: ${ev.security.source_code}`);
  for (const u of ev.urls.slice(0, 2)) lines.push(`url: ${u}`);
  if (ev.ixNames.length) lines.push(`instructions: ${ev.ixNames.slice(0, 6).join(', ')}`);
  for (const s of ev.strings.slice(0, 3)) lines.push(`str: ${s.slice(0, 80)}`);
  if (ev.locked === true) lines.push('program is LOCKED (immutable)');
  const evidence = lines.slice(0, 8).map((l) => ` · ${esc(l)}`).join('\n') || ' · (no readable evidence)';

  return [
    '◎ <b>New program proposal</b>',
    `<code>${esc(id)}</code>`,
    `first seen: ${esc(firstSeen)}`,
    `tx (all-time): ${esc(txTotal)}`,
    '',
    `Suggested: <b>${esc(sug.name)}</b> — ${esc(sug.category)} (${esc(sug.confidence)} confidence)`,
    '',
    '<b>Evidence</b>',
    evidence,
    '',
    'Reply "<i>Name | Category</i>" to override + approve, or use the buttons.',
  ].join('\n');
}

// ── approval flow ────────────────────────────────────────────
async function proposeProgram(id) {
  const ev = await gatherEvidence(id);
  const sug = deriveSuggestion(ev);
  const row = await getProgramRow(id);
  const text = buildProposal(id, row, ev, sug);

  // BUG 2: a low-confidence / unnamed suggestion must NOT be one-tap approvable.
  // Replace the ✅ Approve button with an informational button; reply-override
  // ("Name | Category") becomes the only approval path for these.
  const needsName = sug.name === 'Unknown' || sug.confidence === 'Low';
  const inline_keyboard = needsName
    ? [
        [{ text: '✏️ Needs name — reply Name | Category', callback_data: `nn:${id}` }],
        [{ text: '❌ Skip', callback_data: `sk:${id}` }],
      ]
    : [[
        { text: '✅ Approve', callback_data: `ap:${id}` },
        { text: '❌ Skip', callback_data: `sk:${id}` },
      ]];

  const res = await tg('sendMessage', {
    chat_id: ADMIN, // admin proposals with buttons go ONLY to the admin
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard },
  });
  if (!res) return false; // send failed — leave untracked so we retry next cycle

  // BUG 1: persist the message_id → program_id mapping to disk IMMEDIATELY,
  // before proposing the next candidate. The old code only flushed once at the
  // end of scan(), so a crash/restart or an intervening saveState() mid-scan
  // could leave a PARTIAL proposals map on disk — replies to the not-yet-saved
  // proposals then missed the lookup forever (first reply worked, rest didn't).
  state.programs[id] = { status: 'proposed', proposedAt: Date.now(), messageId: res.message_id, suggested: sug };
  state.proposals[String(res.message_id)] = id;
  saveState();
  log(`proposed ${id} (msg ${res.message_id}, ${sug.confidence}${needsName ? ', needs-name' : ''})`);

  // Channel layer: a new program is a FACT — post it immediately, address-only,
  // never the suggested name (names are claims that wait for approval).
  await channelPostNew(id, row);
  return true;
}

async function approve(id, override, chatId, messageId) {
  const entry = state.programs[id];
  const sug = (entry && entry.suggested) || {};
  const name = (override && override.name) || sug.name || 'Unknown';
  const category = (override && override.category) || sug.category || 'Utility';
  const website = sug.website || undefined;

  const pending = readJson(PENDING_FILE, {});
  pending[id] = { name, category, ...(website ? { website } : {}) };
  writeJsonAtomic(PENDING_FILE, pending);

  state.programs[id] = { ...(entry || {}), status: 'approved', approved: { name, category } };
  saveState();

  const text = [
    `✅ <b>Approved:</b> ${esc(name)} — ${esc(category)}`,
    `<code>${esc(id)}</code>`,
    'Added to pending-registry.json (registry.json untouched).',
    'Next, run for the genesis baseline:',
    `<code>node backfill.js ${esc(id)} --commit</code>`,
    'Then apply the registry additions locally:',
    '<code>node apply-pending.js</code>',
  ].join('\n');
  await tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  log(`approved ${id} as "${name}" / ${category}`);

  // BUG 3: the admin's shell user can't read /home/bots, so ship the full
  // current pending-registry.json to the admin chat every time it changes —
  // they run apply-pending locally by pasting/saving it.
  await sendPendingSnapshot();

  // Channel layer: announce the identification (name is now a vetted claim).
  await channelPostIdentified(id, name, category);

  // Auto-run the genesis backfill in the background (skips if already walked).
  await maybeQueueBackfill(id);
}

async function skipProgram(id, chatId, messageId) {
  state.programs[id] = { ...(state.programs[id] || {}), status: 'skipped' };
  saveState();
  await tg('editMessageText', {
    chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
    text: `❌ <b>Skipped</b>\n<code>${esc(id)}</code>`,
  });
  log(`skipped ${id}`);
}

// ── channel layer (public) + pending snapshot (admin) ────────
async function channelPostNew(id, row) {
  if (!CHANNEL_IS_PUBLIC) return;
  const text = [
    '🆕 <b>New program detected on X1</b>',
    `<code>${esc(id)}</code>`,
    `first seen: ${esc(fmtFirstSeen(row))}`,
    `tx (all-time): ${esc(fmtTxTotal(row))}`,
  ].join('\n');
  await tg('sendMessage', { chat_id: CHANNEL, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

async function channelPostIdentified(id, name, category) {
  if (!CHANNEL_IS_PUBLIC) return;
  const text = [
    `📛 <b>Identified:</b> ${esc(name)} (${esc(category)})`,
    `<code>${esc(id)}</code>`,
  ].join('\n');
  await tg('sendMessage', { chat_id: CHANNEL, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

// Ship the full current pending-registry.json to the admin chat (code block, or
// a document when it would exceed Telegram's practical message length).
async function sendPendingSnapshot() {
  const pending = readJson(PENDING_FILE, {});
  const json = JSON.stringify(pending, null, 2);
  const n = Object.keys(pending).filter((k) => !k.startsWith('_')).length;
  const plural = n === 1 ? 'y' : 'ies';
  if (json.length > DOC_THRESHOLD) {
    await tgDocument(ADMIN, 'pending-registry.json', json,
      `pending-registry.json (${n} entr${plural}) — save locally, then: node apply-pending.js <path>`);
  } else {
    await tg('sendMessage', {
      chat_id: ADMIN, parse_mode: 'HTML', disable_web_page_preview: true,
      text: `📄 <b>pending-registry.json</b> (${n} entr${plural}) — save locally & run <code>node apply-pending.js</code>:\n<pre>${esc(json)}</pre>`,
    });
  }
}

// ── genesis backfill (auto-run on approval, one at a time) ───
// On approval we walk the program's full history via `node backfill.js <id>
// --commit` in a detached child, but only if it has never been walked
// (first_tx_at IS NULL). At most one walk runs at a time; concurrent approvals
// queue behind it.
const backfillQueue = [];
let backfillRunning = false;

async function maybeQueueBackfill(id) {
  try {
    const { rows } = await pool.query(
      `SELECT first_tx_at FROM sonar.programs WHERE program_id = $1`, [id]);
    if (!rows.length) { log(`backfill skip ${id}: no sonar.programs row`); return; }
    if (rows[0].first_tx_at != null) { log(`backfill skip ${id}: already walked (first_tx_at set)`); return; }
  } catch (e) {
    log(`backfill precheck failed for ${id}:`, e.message);
    return;
  }
  if (backfillQueue.includes(id)) return; // dedupe rapid re-approvals
  backfillQueue.push(id);
  log(`backfill queued ${id} (${backfillQueue.length} waiting)`);
  drainBackfillQueue();
}

function drainBackfillQueue() {
  if (backfillRunning) return;
  const id = backfillQueue.shift();
  if (!id) return;
  backfillRunning = true;
  log(`backfill starting genesis walk for ${id}`);

  let child;
  let out = '';
  let err = '';
  try {
    child = spawn('node', ['backfill.js', id, '--commit'], {
      cwd: __dirname,
      detached: true, // own process group — doesn't block or ride the poll loop
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    log(`backfill spawn failed for ${id}:`, e.message);
    backfillRunning = false;
    drainBackfillQueue();
    return;
  }

  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('error', (e) => { err += `spawn error: ${e.message}\n`; });
  child.on('close', (code) => {
    backfillRunning = false;
    notifyBackfill(id, code, out, err).catch((e) => log('notifyBackfill failed:', e.message));
    drainBackfillQueue(); // start the next queued walk, if any
  });
}

async function notifyBackfill(id, code, out, err) {
  if (code === 0) {
    const mTotal = out.match(/total txs\s*:\s*(\d+)/);
    const mOldest = out.match(/oldest tx\s*:\s*(\S+)/);
    const total = mTotal ? Number(mTotal[1]).toLocaleString() : '?';
    const oldest = mOldest && mOldest[1] !== '(unknown)' ? mOldest[1].slice(0, 10) : 'unknown';
    log(`backfill done ${id}: ${total} txs since ${oldest}`);
    await tg('sendMessage', {
      chat_id: ADMIN, parse_mode: 'HTML', disable_web_page_preview: true,
      text: `🧬 <b>Genesis walk done:</b> ${esc(total)} txs since ${esc(oldest)}\n<code>${esc(id)}</code>`,
    });
  } else {
    const reason = (err.trim() || out.trim() || `exit code ${code}`)
      .split('\n').filter(Boolean).slice(-3).join('\n').slice(0, 500);
    log(`backfill failed ${id} (exit ${code}): ${reason}`);
    await tg('sendMessage', {
      chat_id: ADMIN, parse_mode: 'HTML', disable_web_page_preview: true,
      text: `⚠️ <b>Genesis walk failed</b> for <code>${esc(id)}</code> (exit ${code}):\n<pre>${esc(reason)}</pre>`,
    });
  }
}

async function scan() {
  try {
    const reg = readJson(REGISTRY_FILE, {});
    const regKeys = new Set(Object.keys(reg).filter((k) => !k.startsWith('_')));
    const { rows } = await pool.query(
      `SELECT program_id FROM sonar.programs ORDER BY sonar_score DESC NULLS LAST`);
    const candidates = rows
      .filter((r) => !regKeys.has(r.program_id) && !state.programs[r.program_id])
      .slice(0, PROPOSALS_PER_CYCLE);

    if (!candidates.length) return;
    log(`scan: ${candidates.length} new program(s) to propose`);
    for (const c of candidates) {
      try {
        await proposeProgram(c.program_id);
      } catch (e) {
        log(`propose ${c.program_id} failed:`, e.message);
      }
    }
    saveState();
  } catch (e) {
    log('scan failed:', e.message);
  }
}

// ── daily live leaderboard (single pinned message, edited in place) ──
async function postAndPinBoard(text, today, snapshot) {
  const res = await tg('sendMessage', { chat_id: CHANNEL, text, parse_mode: 'HTML', disable_web_page_preview: true });
  if (!res) return false; // send failed — retry on the next minute tick (same hour)
  // Pin silently. If pinning fails (e.g. missing admin rights) we still keep the
  // message and its id — the daily edit works regardless of pin state.
  await tg('pinChatMessage', { chat_id: CHANNEL, message_id: res.message_id, disable_notification: true });
  state.board = { messageId: res.message_id, date: today, top: snapshot };
  saveState();
  log(`posted + pinned live leaderboard (msg ${res.message_id})`);
  return true;
}

async function maybePost() {
  try {
    const now = new Date();
    if (now.getUTCHours() !== POST_HOUR) return;
    const today = now.toISOString().slice(0, 10);
    const board = state.board;
    if (board && board.date === today) return; // already refreshed today

    const rows = await topTen();
    if (!rows.length) return;

    const text = formatBoard(rows, board && board.top, 'X1 Sonar — Live Top 10', today);
    const snapshot = rows.map((r) => ({ program_id: r.program_id, name: r.name, score: r.sonar_score }));

    // Existing pinned message → edit it in place.
    if (board && board.messageId) {
      const j = await tgCall('editMessageText', {
        chat_id: CHANNEL, message_id: board.messageId, text,
        parse_mode: 'HTML', disable_web_page_preview: true,
      });
      if (j && j.ok) {
        state.board = { messageId: board.messageId, date: today, top: snapshot };
        saveState();
        log(`edited live leaderboard (msg ${board.messageId})`);
        return;
      }
      const desc = (j && j.description) || 'network error';
      // Only a genuinely gone/uneditable message justifies a repost; a transient
      // error just waits for the next tick so we don't spawn a duplicate pin.
      const gone = /not found|can'?t be edited|message to edit|MESSAGE_ID_INVALID|to be edited was not found/i.test(desc);
      if (!gone) { log(`live leaderboard edit failed transiently (${desc}) — retrying next tick`); return; }
      log(`live leaderboard message gone (${desc}) — reposting + pinning a fresh one`);
    }

    // First run, or the pinned message was deleted → post + pin a new one.
    await postAndPinBoard(text, today, snapshot);
  } catch (e) {
    log('maybePost failed:', e.message);
  }
}

// ── update handling ──────────────────────────────────────────
async function handleCallback(cq) {
  const chatId = String(cq.message && cq.message.chat && cq.message.chat.id);
  if (chatId !== String(ADMIN)) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not authorized' });
    return;
  }
  const [action, id] = (cq.data || '').split(':');
  if (action === 'ap' && id) {
    await approve(id, null, cq.message.chat.id, cq.message.message_id);
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Approved ✅' });
  } else if (action === 'sk' && id) {
    await skipProgram(id, cq.message.chat.id, cq.message.message_id);
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Skipped' });
  } else if (action === 'nn' && id) {
    // BUG 2: low-confidence/unnamed — no one-tap approve. Explain and wait for
    // a reply-override instead.
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id, show_alert: true,
      text: 'Low-confidence suggestion — reply "Name | Category" to this message to approve it.',
    });
    log(`needs-name tapped for ${id} — awaiting reply-override`);
  } else {
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
  }
}

async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = String(msg.chat.id);

  // /top — open to anyone
  if (/^\/top(@\w+)?\b/.test(text)) {
    const rows = await topTen();
    await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: formatBoard(rows, state.board && state.board.top, 'X1 Sonar — Top 10'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return;
  }

  // Reply to a proposal — admin only. BUG 1: log EVERY reply with an outcome,
  // matched or unmatched, so a miss can never again fail silently.
  if (msg.reply_to_message) {
    const rid = String(msg.reply_to_message.message_id);
    if (chatId !== String(ADMIN)) {
      log(`reply ignored: from non-admin chat ${chatId} (reply-to msg ${rid})`);
    } else {
      const id = state.proposals[rid];
      if (!id) {
        log(`reply ignored: reply-to msg ${rid} not in proposals map (not a proposal, or proposed before a restart)`);
      } else if (!text.includes('|')) {
        log(`reply ignored: matched proposal ${id} but no "Name | Category" separator (text: ${JSON.stringify(text.slice(0, 60))})`);
      } else {
        const [name, category] = text.split('|').map((s) => s.trim());
        if (!name) {
          log(`reply ignored: matched proposal ${id} but empty name`);
        } else {
          log(`reply matched proposal ${id} → approving as "${name}" / ${category || '(keep suggested category)'}`);
          await approve(id, { name, category: category || undefined }, msg.chat.id, msg.reply_to_message.message_id);
        }
      }
    }
  }
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  if (u.message) return handleMessage(u.message);
}

// ── main long-poll loop ──────────────────────────────────────
async function pollLoop() {
  let backoff = 1000;
  for (;;) {
    const updates = await tg(
      'getUpdates',
      { offset: state.offset, timeout: POLL_TIMEOUT, allowed_updates: ['message', 'callback_query'] },
      (POLL_TIMEOUT + 15) * 1000,
    );
    if (updates === null) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
      continue;
    }
    backoff = 1000;
    for (const u of updates) {
      state.offset = u.update_id + 1;
      try {
        await handleUpdate(u);
      } catch (e) {
        log('handleUpdate failed:', e.message);
      }
    }
    if (updates.length) saveState();
  }
}

async function main() {
  log(`sonar-watch starting — admin=${ADMIN} channel=${CHANNEL} post-hour=${POST_HOUR}h UTC`);
  // periodic approval scan + daily-post minute tick
  setInterval(() => { scan(); }, SCAN_INTERVAL_MS);
  setInterval(() => { maybePost(); }, 60 * 1000);
  setTimeout(() => { scan(); }, 5000); // first scan shortly after boot
  await pollLoop();
}

process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => log('uncaughtException:', e && e.message));

if (require.main === module) {
  main().catch((e) => { log('main crashed:', e.message); process.exit(1); });
}

// Exported for unit tests; requiring this module does NOT start the bot.
module.exports = { formatBoard, deriveSuggestion, parseSecurityTxt, extractStrings, buildProposal };

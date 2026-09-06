"use client";
import registry from "../registry.json";

import { useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "https://sonar-api.x1forge.xyz";
const EXPLORER = "https://explorer.x1.xyz/address";
const REFRESH_MS = 30000;

const COLS = [
  { key: "rank", label: "#", left: false },
  { key: "program_id", label: "Program", left: true },
  { key: "category", label: "Category", left: true },
  { key: "upgrade_state", label: "Upgrade", left: true },
  { key: "signals", label: "Signals", left: true, nosort: true },
  { key: "sonar_score", label: "Sonar Score", left: false },
  { key: "tx_count_24h", label: "TX 24h", left: false },
  { key: "tx_count_30d", label: "TX 30D", left: false },
  { key: "tx_all_time", label: "TX All-Time", left: false },
  { key: "unique_signers_30d", label: "Signers 30D", left: false },
  { key: "success_rate_24h", label: "Success", left: false },
  { key: "sparkline", label: "7d Trend", left: false, nosort: true },
  { key: "last_active_at", label: "Last Active", left: false },
];

// Columns sorted as text rather than numbers. Program sorts by display name.
const TEXT_SORT = {
  program_id: (p) => p.name || p.program_id,
  category: (p) => p.category || "Unknown",
  upgrade_state: (p) => p.upgrade_state || "",
};

function timeAgo(iso) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function short(id) {
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

// registry.json is mixed-format: an entry is either an object
// ({ name, category, website, cluster, deployer, ... }) or a bare string
// (just the name). Normalize so callers can read fields either way.
function regMeta(id) {
  const v = registry[id];
  if (typeof v === "string") return { name: v };
  return v && typeof v === "object" ? v : {};
}

// Cluster = ecosystem the program belongs to (e.g. "XDEX", "PumX"). The API
// stamps it from the registry; fall back to the bundled registry so the tag
// still shows if the API build is older than the dashboard.
function clusterOf(p) {
  const c = p.cluster || regMeta(p.program_id).cluster;
  return typeof c === "string" && c ? c : null;
}

// Deployer = the wallet that deployed the program. Stamped by the API from
// the registry; fall back to the bundled registry like clusterOf.
function deployerOf(p) {
  const d = p.deployer || regMeta(p.program_id).deployer;
  return typeof d === "string" && d ? d : null;
}

const SOLO_KEY = "__solo__";
const SOLO_LABEL = "Solo / Unknown deployer";

// Group rows by deployer address. Each group is labelled with the cluster
// name if that deployer has one (most common cluster among its programs),
// otherwise a shortened address. Groups are ordered by total activity
// (TX 30D, then TX 24h as tiebreak). Deployers with a single program and
// programs with no deployer land in a final "Solo / Unknown deployer"
// section. Rows keep the table's current sort within a group.
function groupByDeployer(rows) {
  const groups = new Map();
  const add = (key, p) => {
    if (!groups.has(key)) groups.set(key, { key, rows: [], tx30d: 0, tx24h: 0, clusters: new Map() });
    const g = groups.get(key);
    g.rows.push(p);
    g.tx30d += Number(p.tx_count_30d) || 0;
    g.tx24h += Number(p.tx_count_24h) || 0;
    const c = clusterOf(p);
    if (c) g.clusters.set(c, (g.clusters.get(c) || 0) + 1);
  };
  for (const p of rows) add(deployerOf(p) || SOLO_KEY, p);

  // Fold single-program deployers into the solo section, preserving the
  // table's sort order among them.
  const solo = { key: SOLO_KEY, label: SOLO_LABEL, rows: [], tx30d: 0, tx24h: 0 };
  const out = [];
  for (const g of groups.values()) {
    if (g.key === SOLO_KEY || g.rows.length < 2) {
      for (const p of g.rows) solo.rows.push(p);
      solo.tx30d += g.tx30d;
      solo.tx24h += g.tx24h;
      continue;
    }
    const top = [...g.clusters.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    g.label = top ? top[0] : `${g.key.slice(0, 8)}…`;
    g.title = g.key;
    out.push(g);
  }
  out.sort((a, b) => b.tx30d - a.tx30d || b.tx24h - a.tx24h || a.label.localeCompare(b.label));
  if (solo.rows.length) {
    const order = new Map(rows.map((p, i) => [p.program_id, i]));
    solo.rows.sort((a, b) => order.get(a.program_id) - order.get(b.program_id));
    out.push(solo);
  }
  return out;
}

// ── Deployer portfolio ────────────────────────────────────────
// Every program deployed by each deployer wallet, built from the API program
// list merged with the bundled registry (so siblings outside the fetched
// leaderboard page still count). Purely factual: one wallet can deploy
// unrelated things, so this never implies a shared project or team. No
// exclusions — core/infra wallets are listed like any other.
function buildPortfolios(programs) {
  const byId = new Map();
  for (const [id, raw] of Object.entries(registry)) {
    if (id.startsWith("_")) continue;
    const m = regMeta(id);
    byId.set(id, { program_id: id, name: m.name || null, deployer: m.deployer || null });
  }
  for (const p of programs) {
    const prev = byId.get(p.program_id) || {};
    byId.set(p.program_id, {
      ...prev,
      program_id: p.program_id,
      name: p.name || prev.name || null,
      deployer: deployerOf(p) || prev.deployer || null,
      sonar_score: Number(p.sonar_score) || 0,
    });
  }
  const out = new Map();
  for (const e of byId.values()) {
    if (!e.deployer) continue;
    if (!out.has(e.deployer)) out.set(e.deployer, []);
    out.get(e.deployer).push(e);
  }
  for (const list of out.values()) {
    // Named first, then by score, then by name/id — stable and readable.
    list.sort(
      (a, b) =>
        (b.name ? 1 : 0) - (a.name ? 1 : 0) ||
        (b.sonar_score || 0) - (a.sonar_score || 0) ||
        (a.name || a.program_id).localeCompare(b.name || b.program_id)
    );
  }
  return out;
}

// ── Risk signals ──────────────────────────────────────────────
// Objective on-chain facts, never verdicts. Each badge carries a tooltip
// spelling out the fact behind it. Rendered in the order the API returns them
// (most-notable first; `upgradeable` is lowest-weight and comes last).
const SIGNAL_DEFS = {
  closed:       { glyph: "†", text: "CLOSED",       cls: "sig-closed" },
  failures:     { glyph: "⚠", text: "FAILING",      cls: "sig-warn" },
  concentrated: { glyph: "⚠", text: "CONCENTRATED", cls: "sig-warn" },
  cliff:        { glyph: "▼", text: "CLIFF",        cls: "sig-warn" },
  anonymous:    { glyph: "?", text: "ANON",         cls: "sig-info" },
  new:          { glyph: "",  text: "NEW",          cls: "sig-new" },
  upgradeable:  { glyph: "⬆", text: "UPGRADEABLE",  cls: "sig-dim" },
};

// Only substantive signals earn a column badge. `new` and `upgradeable` still
// live in the API and count toward watchlist qualification, but they render on
// most rows and duplicate existing UI (the UPGRADE column, the teal NEW pill),
// so they are kept out of the column to let it stay quiet until it matters.
const COLUMN_SIGNALS = new Set(["concentrated", "cliff", "failures", "anonymous", "closed"]);

const nfmt = (v) => Number(v || 0).toLocaleString();

function signalTip(sig, p) {
  switch (sig) {
    case "closed":
      return p.closed_at
        ? `Program account no longer exists on-chain (since ${new Date(p.closed_at).toISOString().slice(0, 10)}).`
        : "Program account no longer exists on-chain.";
    case "failures":
      return `${p.success_rate_24h == null ? "?" : Math.round(p.success_rate_24h * 100)}% success over ${nfmt(p.tx_count_24h)} txs in 24h.`;
    case "concentrated":
      return `${nfmt(p.unique_signers_30d)} signers / ${nfmt(p.tx_count_30d)} txs in 30d — activity concentrated among very few wallets.`;
    case "cliff":
      return `${nfmt(p.tx_all_time)} all-time txs but only ${nfmt(p.tx_count_30d)} in the last 30d.`;
    case "anonymous":
      return "No known name and no website in the registry.";
    case "new":
      return "First on-chain transaction within the last 30 days.";
    case "upgradeable":
      return "Program is upgradeable — its code can still change.";
    default:
      return sig;
  }
}

// Signals that count toward the Watchlist. `upgradeable` is informational and
// too common to be meaningful on its own, so it never counts — a program is on
// the watchlist only with 2+ substantive signals, or if it is closed.
function substantiveSignals(p) {
  return (p.signals || []).filter((s) => s !== "upgradeable");
}
function onWatchlist(p) {
  return !!p.closed_at || substantiveSignals(p).length >= 2;
}

function Signals({ p }) {
  const sigs = (p.signals || []).filter((s) => COLUMN_SIGNALS.has(s));
  if (!sigs.length) return null; // stay blank unless something warrants a look
  return (
    <span className="sig-cluster">
      {sigs.map((s) => {
        const d = SIGNAL_DEFS[s] || { glyph: "", text: String(s).toUpperCase(), cls: "sig-info" };
        return (
          <span key={s} className={`sig ${d.cls}`} title={signalTip(s, p)}>
            {d.glyph && <span className="sig-g">{d.glyph}</span>}
            {d.text}
          </span>
        );
      })}
    </span>
  );
}

function Sparkline({ data }) {
  const pts = (data || []).map(Number);
  if (pts.length < 2) return <span className="dim">·</span>;
  const max = Math.max(...pts, 1);
  const w = 64, h = 18;
  const line = pts
    .map((v, i) => `${(i / (pts.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`)
    .join(" ");
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={line} fill="none" stroke="var(--ping)" strokeWidth="1.5" />
    </svg>
  );
}

function Radar({ count }) {
  // Deterministic blips seeded by index — one per tracked program, capped
  const blips = Array.from({ length: Math.min(count || 5, 14) }, (_, i) => {
    const a = (i * 137.5 * Math.PI) / 180; // golden-angle spread
    const r = 6 + ((i * 7919) % 15);
    return { x: 26 + Math.cos(a) * r, y: 26 + Math.sin(a) * r, d: (i % 8) * 0.5 };
  });
  return (
    <div className="radar" aria-hidden="true">
      <svg viewBox="0 0 52 52">
        <circle cx="26" cy="26" r="24" fill="none" stroke="var(--line)" />
        <circle cx="26" cy="26" r="15" fill="none" stroke="var(--line)" />
        <circle cx="26" cy="26" r="6" fill="none" stroke="var(--line)" />
        <line x1="2" y1="26" x2="50" y2="26" stroke="var(--line)" />
        <line x1="26" y1="2" x2="26" y2="50" stroke="var(--line)" />
        <g className="sweep">
          <path d="M26 26 L26 2 A24 24 0 0 1 43 9 Z" fill="var(--ping)" opacity="0.14" />
          <line x1="26" y1="26" x2="26" y2="2" stroke="var(--ping)" strokeWidth="1.5" />
        </g>
        {blips.map((b, i) => (
          <circle key={i} className="blip" cx={b.x} cy={b.y} r="1.6" style={{ animationDelay: `${b.d}s` }} />
        ))}
      </svg>
    </div>
  );
}

export default function Home() {
  const [programs, setPrograms] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [sort, setSort] = useState({ key: "sonar_score", dir: "desc" });
  const [copied, setCopied] = useState(null);
  const [cat, setCat] = useState("All");
  const [appsOnly, setAppsOnly] = useState(true);
  const [watchlist, setWatchlist] = useState(false);
  const [byDeployer, setByDeployer] = useState(false);
  const [openPortfolio, setOpenPortfolio] = useState(null); // program_id whose deployer list is expanded

  async function load() {
    try {
      const [p, s] = await Promise.all([
        fetch(`${API}/api/programs?sort=score&limit=200`).then((r) => r.json()),
        fetch(`${API}/api/stats`).then((r) => r.json()),
      ]);
      setPrograms(p.programs || []);
      setStats(s);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError("Signal lost — could not reach the Sonar API. Retrying on next sweep.");
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const cats = useMemo(() => {
    const s = new Set((programs || []).map((p) => p.category || "Unknown"));
    return ["All", ...[...s].sort()];
  }, [programs]);

  const rows = useMemo(() => {
    if (!programs) return null;
    const arr = programs.filter(
      (p) =>
        (cat === "All" || (p.category || "Unknown") === cat) &&
        (!appsOnly || !p.infrastructure) &&
        (!watchlist || onWatchlist(p))
    );
    const { key, dir } = sort;
    const sign = dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av, bv;
      if (key === "last_active_at") {
        av = new Date(a[key] || 0).getTime();
        bv = new Date(b[key] || 0).getTime();
      } else if (TEXT_SORT[key]) {
        // Text columns compare case-insensitively; "desc" means Z→A.
        av = TEXT_SORT[key](a).toLowerCase();
        bv = TEXT_SORT[key](b).toLowerCase();
      } else {
        // Null metrics (e.g. tx_all_time on system/infra programs) always
        // sort last, in either direction; real zeros still compare as 0.
        const an = a[key] == null, bn = b[key] == null;
        if (an !== bn) return an ? 1 : -1;
        av = Number(a[key]) || 0;
        bv = Number(b[key]) || 0;
      }
      if (av < bv) return -sign;
      if (av > bv) return sign;
      // Tiebreak on Sonar score so equal values keep a stable, meaningful order.
      return (Number(b.sonar_score) || 0) - (Number(a.sonar_score) || 0);
    });
    return arr;
  }, [programs, sort, cat, appsOnly, watchlist]);

  const groups = useMemo(() => (byDeployer && rows ? groupByDeployer(rows) : null), [rows, byDeployer]);

  const portfolios = useMemo(() => buildPortfolios(programs || []), [programs]);

  const maxScore = useMemo(
    () => (programs || []).reduce((m, p) => Math.max(m, Number(p.sonar_score) || 0), 1),
    [programs]
  );

  function clickSort(key) {
    if (COLS.find((c) => c.key === key)?.nosort) return;
    if (key === "rank") key = "sonar_score";
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }
    );
  }

  // "Top volume" is a shortcut for sorting by TX All-Time descending. It is
  // derived from the sort state, so the header arrow agrees with the pill and
  // clicking any other column header naturally switches it off.
  const topVolume = sort.key === "tx_all_time" && sort.dir === "desc";
  function toggleTopVolume() {
    setSort(topVolume ? { key: "sonar_score", dir: "desc" } : { key: "tx_all_time", dir: "desc" });
  }

  function copyId(id) {
    navigator.clipboard?.writeText(id);
    setCopied(id);
    setTimeout(() => setCopied(null), 1200);
  }

  function renderRow(p, i) {
    const main = renderMainRow(p, i);
    if (openPortfolio !== p.program_id) return main;
    const d = deployerOf(p);
    const list = (d && portfolios.get(d)) || [];
    return [
      main,
      <tr key={`${p.program_id}:deployer`} className="prov-row">
        <td colSpan={COLS.length} className="left">
          <div className="prov-head">
            Deployer{" "}
            <a href={`${EXPLORER}/${d}`} target="_blank" rel="noopener noreferrer" title={d}>
              {short(d)}
            </a>{" "}
            deployed {list.length} programs on X1, including this one. Same deployer wallet only —
            this does not imply a shared project or team.
          </div>
          <ul className="prov-list">
            {list.map((e) => (
              <li key={e.program_id} className={e.program_id === p.program_id ? "self" : ""}>
                <a href={`${EXPLORER}/${e.program_id}`} target="_blank" rel="noopener noreferrer" title={e.program_id}>
                  {e.name || short(e.program_id)}
                </a>
                {!e.name && <span className="prov-unnamed">unnamed</span>}
                {e.program_id === p.program_id && <span className="prov-self">this program</span>}
              </li>
            ))}
          </ul>
        </td>
      </tr>,
    ];
  }

  function renderMainRow(p, i) {
    return (
      <tr key={p.program_id} style={{ animationDelay: `${Math.min(i * 35, 700)}ms` }}>
        <td className="rank" data-l="Rank">{p.rank}</td>
        <td className="left" data-l="Program">
          <span className="pid">
            <a
              href={`${EXPLORER}/${p.program_id}`}
              target="_blank"
              rel="noopener noreferrer"
              title={p.program_id}
            >
              {p.name || short(p.program_id)}
            </a>
            <button className="copy" onClick={() => copyId(p.program_id)}>
              {copied === p.program_id ? "ok" : "copy"}
            </button>
            {regMeta(p.program_id).website && (
              <a className="site" href={regMeta(p.program_id).website} target="_blank" rel="noopener noreferrer">site ↗</a>
            )}
            {clusterOf(p) && (
              <span className="cluster-tag" title={`Part of the ${clusterOf(p)} ecosystem`}>
                {clusterOf(p)}
              </span>
            )}
            {(() => {
              const d = deployerOf(p);
              const list = d ? portfolios.get(d) : null;
              if (!list || list.length < 2) return null;
              const open = openPortfolio === p.program_id;
              const preview = list.map((e) => e.name || short(e.program_id)).join(", ");
              return (
                <button
                  type="button"
                  className={`prov-chip ${open ? "on" : ""}`}
                  onClick={() => setOpenPortfolio(open ? null : p.program_id)}
                  aria-expanded={open}
                  title={`Deployer ${d} also deployed: ${preview}`}
                >
                  deployer: {list.length} programs {open ? "▴" : "▾"}
                </button>
              );
            })()}
            {p.is_new && <span className="badge-new">NEW</span>}
          </span>
        </td>
        <td className="left" data-l="Category">
          <span className={`cat cat-${(p.category || "Unknown").toLowerCase()}`}>
            {p.category || "Unknown"}
          </span>
        </td>
        <td className="left" data-l="Upgrade">
          {p.infrastructure ? (
            <span className="up up-system">SYSTEM</span>
          ) : p.upgrade_state === "locked" ? (
            <span className="up up-locked">LOCKED</span>
          ) : p.upgrade_state === "upgradeable" ? (
            <span className="up up-open">UPGRADEABLE</span>
          ) : (
            <span className="dim">—</span>
          )}
        </td>
        <td className="left" data-l="Signals">
          <Signals p={p} />
        </td>
        <td data-l="Sonar Score">
          <span className="scorecell">
            <span className="scorebar">
              <i style={{ width: `${(Number(p.sonar_score) / maxScore) * 100}%` }} />
            </span>
            <span className="score">{Number(p.sonar_score).toFixed(0)}</span>
          </span>
        </td>
        <td data-l="TX 24h">{Number(p.tx_count_24h).toLocaleString()}</td>
        <td data-l="TX 30D">{Number(p.tx_count_30d).toLocaleString()}</td>
        <td data-l="TX All-Time" className={p.tx_all_time == null ? "dim" : undefined}>
          {p.tx_all_time == null ? "—" : Number(p.tx_all_time).toLocaleString()}
        </td>
        <td data-l="Signers 30D">{Number(p.unique_signers_30d).toLocaleString()}</td>
        <td
          data-l="Success"
          className={
            p.success_rate_24h == null
              ? "dim"
              : p.success_rate_24h >= 0.9
              ? "ok"
              : "warn"
          }
        >
          {p.success_rate_24h == null ? "—" : `${Math.round(p.success_rate_24h * 100)}%`}
        </td>
        <td data-l="7d Trend"><Sparkline data={p.sparkline_7d} /></td>
        <td data-l="Last Active" className="dim">{timeAgo(p.last_active_at)}</td>
      </tr>
    );
  }

  return (
    <div className="wrap">
      <header>
        <Radar count={stats?.total_programs} />
        <div className="wordmark">
          <span className="x1">X1</span> <span className="sonar">SONAR</span>
        </div>
        <div className="headmeta">
          <div className="tagline">
            See what&apos;s actually live on X1.
            <br />
            Every program, ranked by real on-chain activity.
          </div>
          <a className="apinote" href="/agents">
            Building an agent or bot? Sonar has a machine-readable API{" "}
            <span className="arrow">→</span>
          </a>
          <div className="headlinks">
            <a className="chip" href="/agents">🤖 Agents</a>
            <a className="chip" href="https://t.me/x1sonar" target="_blank" rel="noopener noreferrer">
              📡 Telegram
            </a>
          </div>
        </div>
      </header>

      <div className="readouts">
        <div className="readout">
          <div className="label">Programs tracked</div>
          <div className="value">{stats ? stats.total_programs : "—"}</div>
        </div>
        <div className="readout">
          <div className="label">Active 24h</div>
          <div className="value">{stats ? stats.active_24h : "—"}</div>
        </div>
        <div className="readout">
          <div className="label">App TX 24h</div>
          <div className="value plain">{stats ? Number(stats.tx_24h).toLocaleString() : "—"}</div>
        </div>
        <div className="readout">
          <div className="label">New 24h</div>
          <div className="value plain">{stats ? stats.new_24h : "—"}</div>
        </div>
      </div>

      <div className="statusline">
        <span className="dot" />
        {error
          ? "reacquiring signal…"
          : updatedAt
          ? `scanning · updated ${updatedAt.toLocaleTimeString()} · refreshes every 30s`
          : "acquiring signal…"}
      </div>

      <div className="pills">
        {cats.map((c) => (
          <button key={c} className={`pill ${cat === c ? "on" : ""}`} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
        <div className="toggles">
          <button
            className={`pill toggle ${appsOnly ? "on" : ""}`}
            onClick={() => setAppsOnly((v) => !v)}
            title="Hide standard infrastructure programs (Token, ATA, Memo, Metaplex)"
          >
            {appsOnly ? "◉" : "○"} Apps only
          </button>
          <button
            className={`pill toggle ${watchlist ? "on" : ""}`}
            onClick={() => setWatchlist((v) => !v)}
            title="Show only programs with 2+ objective on-chain signals (or closed accounts)"
          >
            {watchlist ? "◉" : "○"} ⚠ Watchlist
          </button>
          <button
            className={`pill toggle ${topVolume ? "on" : ""}`}
            onClick={toggleTopVolume}
            title="Sort by all-time transaction count, highest first (programs without an all-time count sort last)"
          >
            {topVolume ? "◉" : "○"} Top volume
          </button>
          <button
            className={`pill toggle ${byDeployer ? "on" : ""}`}
            onClick={() => setByDeployer((v) => !v)}
            title="Group programs by deployer wallet, ordered by total activity"
          >
            {byDeployer ? "◉" : "○"} Group by deployer
          </button>
        </div>
      </div>

      <div className="board">
        {error && !programs ? (
          <div className="error">{error}</div>
        ) : !rows ? (
          <div className="empty">Sweeping the chain…</div>
        ) : rows.length === 0 ? (
          <div className="empty">No programs on the scope yet. The indexer is listening.</div>
        ) : (
          <table>
            <thead>
              <tr>
                {COLS.map((c) => {
                  const active = sort.key === (c.key === "rank" ? "sonar_score" : c.key);
                  return (
                    <th
                      key={c.key}
                      className={`${c.left ? "left " : ""}${c.nosort ? "nosort " : ""}${active ? "on" : ""}`}
                      onClick={() => clickSort(c.key)}
                    >
                      {c.label}{" "}
                      {active && <span className="arrow">{sort.dir === "desc" ? "▼" : "▲"}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {groups
                ? groups.reduce(
                    (acc, g) => {
                      acc.nodes.push(
                        <tr key={`group:${g.key}`} className="group-row">
                          <td colSpan={COLS.length} className="left">
                            <span className="gname" title={g.title}>{g.label}</span>
                            <span className="gcount">
                              {g.rows.length} program{g.rows.length === 1 ? "" : "s"}
                            </span>
                            <span className="gact" title="Combined TX 30D across the group">
                              {nfmt(g.tx30d)} tx 30d
                            </span>
                          </td>
                        </tr>
                      );
                      for (const p of g.rows) acc.nodes.push(renderRow(p, acc.i++));
                      return acc;
                    },
                    { nodes: [], i: 0 }
                  ).nodes
                : rows.map((p, i) => renderRow(p, i))}
            </tbody>
          </table>
        )}
      </div>

      {watchlist && (
        <div className="watchnote">
          Signals are objective on-chain facts, not verdicts. Do your own research.
        </div>
      )}

      <footer>
        <span>X1 Sonar · an Echo Hound Labs instrument</span>
        <a href="https://github.com/echohound-labs/x1-sonar" target="_blank" rel="noopener noreferrer">
          open source
        </a>
        <a href="/agents">public API</a>
      </footer>
    </div>
  );
}

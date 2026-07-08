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
  { key: "sonar_score", label: "Sonar Score", left: false },
  { key: "tx_count_24h", label: "TX 24h", left: false },
  { key: "tx_count_30d", label: "TX 30D", left: false },
  { key: "tx_all_time", label: "TX All-Time", left: false },
  { key: "unique_signers_30d", label: "Signers 30D", left: false },
  { key: "success_rate_24h", label: "Success", left: false },
  { key: "sparkline", label: "7d Trend", left: false, nosort: true },
  { key: "last_active_at", label: "Last Active", left: false },
];

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
        (!appsOnly || !p.infrastructure)
    );
    const { key, dir } = sort;
    arr.sort((a, b) => {
      let av = a[key], bv = b[key];
      if (key === "last_active_at") { av = new Date(av || 0).getTime(); bv = new Date(bv || 0).getTime(); }
      else if (key !== "program_id") { av = Number(av) || 0; bv = Number(bv) || 0; }
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [programs, sort, cat, appsOnly]);

  const maxScore = useMemo(
    () => (programs || []).reduce((m, p) => Math.max(m, Number(p.sonar_score) || 0), 1),
    [programs]
  );

  function clickSort(key) {
    if (key === "sparkline") return;
    if (key === "rank") key = "sonar_score";
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }
    );
  }

  function copyId(id) {
    navigator.clipboard?.writeText(id);
    setCopied(id);
    setTimeout(() => setCopied(null), 1200);
  }

  return (
    <div className="wrap">
      <header>
        <Radar count={stats?.total_programs} />
        <div className="wordmark">
          <span className="x1">X1</span> <span className="sonar">SONAR</span>
        </div>
        <div className="tagline">
          See what&apos;s actually live on X1.
          <br />
          Every program, ranked by real on-chain activity.
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
        <button
          className={`pill toggle ${appsOnly ? "on" : ""}`}
          onClick={() => setAppsOnly((v) => !v)}
          title="Hide standard infrastructure programs (Token, ATA, Memo, Metaplex)"
        >
          {appsOnly ? "◉" : "○"} Apps only
        </button>
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
                      className={`${c.left ? "left " : ""}${active ? "on" : ""}`}
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
              {rows.map((p, i) => (
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
                      {registry[p.program_id]?.website && (
                        <a className="site" href={registry[p.program_id].website} target="_blank" rel="noopener noreferrer">site ↗</a>
                      )}
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
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer>
        <span>X1 Sonar · an Echo Hound Labs instrument</span>
        <a href="https://github.com/echohound-labs/x1-sonar" target="_blank" rel="noopener noreferrer">
          open source
        </a>
        <a href={`${API}/api/programs`} target="_blank" rel="noopener noreferrer">
          public API
        </a>
        <a href="/agents">for agents</a>
      </footer>
    </div>
  );
}

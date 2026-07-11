import Link from "next/link";

export const metadata = {
  title: "X1 Sonar for Agents — the machine-readable map of X1",
  description:
    "One GET request returns every program on X1 — named, verified, and measured to its genesis transaction. Free, MIT, no auth.",
};

const API = process.env.NEXT_PUBLIC_API_URL || "https://sonar-api.x1forge.xyz";

const BOOTSTRAP_SAMPLE = `{
  "source": "x1sonar.xyz",
  "chain": "X1",
  "license": "MIT",
  "generated_at": "2026-07-08T18:00:00.000Z",
  "program_count": 61,
  "docs": "https://x1sonar.xyz/agents",
  "programs": [
    {
      "program_id": "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN",
      "name": "XDEX",
      "category": "DEX",
      "website": "https://xdex.xyz",
      "infrastructure": false,
      "first_tx_at": "2025-12-01T09:14:32.000Z",
      "tx_all_time": 854931,
      "tx_30d": 121840,
      "unique_signers_30d": 688,
      "sonar_score": 944.6,
      "last_active_at": "2026-07-08T17:59:12.000Z"
    }
    // …one entry per tracked program, sonar_score desc
  ]
}`;

const PROGRAMS_SAMPLE = `{
  "total": 61,
  "limit": 50,
  "offset": 0,
  "programs": [
    {
      "program_id": "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN",
      "name": "XDEX",
      "category": "DEX",
      "rank": 1,
      "sonar_score": 944.6,
      "tx_count_24h": 4180,
      "tx_count_30d": 121840,
      "tx_all_time": 854931,
      "unique_signers_30d": 688,
      "success_rate_24h": 0.99,
      "infrastructure": false,
      "is_new": false,
      "sparkline_7d": [3980, 4210, 3890, 4320, 4470, 4110, 4180]
    }
    // …
  ]
}`;

const PROGRAM_SAMPLE = `{
  "program_id": "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN",
  "name": "XDEX",
  "category": "DEX",
  "website": "https://xdex.xyz",
  "first_tx_at": "2025-12-01T09:14:32.000Z",
  "tx_all_time": 854931,
  "tx_count_30d": 121840,
  "unique_signers_30d": 688,
  "sonar_score": 944.6,
  "upgrade_state": "upgradeable",
  "infrastructure": false,
  "rank": 1
}`;

const HISTORY_SAMPLE = `{
  "program_id": "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN",
  "days": 30,
  "history": [
    { "date": "2026-06-09", "tx_count": 3980, "unique_signers": 142 },
    { "date": "2026-06-10", "tx_count": 4210, "unique_signers": 151 }
    // …one row per day
  ]
}`;

const STATS_SAMPLE = `{
  "total_programs": 61,
  "active_24h": 34,
  "new_24h": 1,
  "tx_24h": 58211,
  "signers_24h": 4102
}`;

const DETECT_SAMPLE = `# every few minutes:
curl -s ${API}/api/agents/bootstrap \\
  | jq -r '.programs[].program_id' | sort > now.txt
comm -13 seen.txt now.txt      # program_ids that just appeared = new deployments
mv now.txt seen.txt`;

function Endpoint({ method = "GET", route, desc, curl, sample, primary }) {
  return (
    <div className={`endpoint${primary ? " primary-endpoint" : ""}`}>
      <div className="sig">
        <span className="method">{method}</span>
        <span className="route">{route}</span>
      </div>
      <p className="desc">{desc}</p>
      <div className="kicker">Request</div>
      <pre className="code">{curl}</pre>
      <div className="kicker">Response</div>
      <pre className="code">{sample}</pre>
    </div>
  );
}

export default function Agents() {
  return (
    <div className="wrap">
      <header>
        <Link href="/" className="wordmark">
          <span className="x1">X1</span> <span className="sonar">SONAR</span>
        </Link>
        <div className="tagline">
          the machine-readable map of X1
          <br />
          built for agents
        </div>
      </header>

      <div className="doc">
        <p className="pagenote">
          This page is Sonar&apos;s API — the same verified program data behind
          x1sonar.xyz, packaged for agents, bots, and developers to consume
          directly.
        </p>
        <h1>
          The complete map of X1 <span className="accent">— for machines.</span>
        </h1>
        <p className="lede">
          Every program on X1, not just the core set. Named, verified, and
          measured back to its genesis transaction. One GET request — no
          subscription, no on-chain signup, no tiers. Free and open source, MIT.
        </p>

        <p className="signpost">
          Building an agent? Give it a verifiable identity — register a Hound Tag{" "}
          →{" "}
          <a
            className="inline"
            href="https://houndtag.xyz"
            target="_blank"
            rel="noopener noreferrer"
          >
            houndtag.xyz
          </a>
        </p>

        <h2>Start here — bootstrap</h2>
        <p>
          One call returns every tracked program (infrastructure included and
          flagged), ordered by Sonar Score. Cached 60s. This is the only endpoint
          most agents need.
        </p>
        <Endpoint
          primary
          route="/api/agents/bootstrap"
          desc="The whole program map in one object: identity, category, website, activity to genesis, and score."
          curl={`curl -s ${API}/api/agents/bootstrap`}
          sample={BOOTSTRAP_SAMPLE}
        />

        <h2>Other endpoints</h2>

        <Endpoint
          route="/api/programs"
          desc="Paginated leaderboard. Query: sort, order, limit (≤200), offset, category, new=true. Includes rank and a 7-day sparkline."
          curl={`curl -s "${API}/api/programs?sort=score&limit=50"`}
          sample={PROGRAMS_SAMPLE}
        />

        <Endpoint
          route="/api/programs/:id"
          desc="Full detail for one program by base58 program id, including its current rank."
          curl={`curl -s ${API}/api/programs/sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`}
          sample={PROGRAM_SAMPLE}
        />

        <Endpoint
          route="/api/programs/:id/history"
          desc="Daily transaction and unique-signer counts. Query: days (1–365, default 30)."
          curl={`curl -s "${API}/api/programs/sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN/history?days=30"`}
          sample={HISTORY_SAMPLE}
        />

        <Endpoint
          route="/api/stats"
          desc="Global chain numbers powering the dashboard header."
          curl={`curl -s ${API}/api/stats`}
          sample={STATS_SAMPLE}
        />

        <h2>Detecting new deployments</h2>
        <p>
          Poll <code className="ic">/api/agents/bootstrap</code> every few minutes
          and diff the set of <code className="ic">program_id</code>s against your
          last snapshot. Any id that wasn&apos;t there before is a newly
          discovered program.
        </p>
        <pre className="code">{DETECT_SAMPLE}</pre>
        <p>
          For real-time deploy alerts without polling, the{" "}
          <a
            className="inline"
            href="https://t.me/x1sonar"
            target="_blank"
            rel="noopener noreferrer"
          >
            t.me/x1sonar
          </a>{" "}
          channel posts every new program the moment it&apos;s detected on-chain.
        </p>
      </div>

      <footer>
        <span>X1 Sonar · an Echo Hound Labs instrument</span>
        <Link href="/">dashboard</Link>
        <a
          href="https://github.com/echohound-labs/x1-sonar"
          target="_blank"
          rel="noopener noreferrer"
        >
          open source
        </a>
        <a href={`${API}/api/agents/bootstrap`} target="_blank" rel="noopener noreferrer">
          bootstrap API
        </a>
        <a href="/llms.txt">llms.txt</a>
      </footer>
    </div>
  );
}

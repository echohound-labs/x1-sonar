# X1 Sonar — Phase 1, Step 1-2 (schema + indexer)

## Deploy on the validator (as x1, files owned by bots)

1. Copy this folder to /home/bots/x1-sonar and `npm install` there
2. Apply schema:   sudo -u postgres psql -d echohound -f schema.sql
3. Verify tables:  sudo -u postgres psql -d echohound -c "\dt sonar.*"
4. cp .env.example .env — set the indexer password (same as x1forge .env)
5. Smoke test in foreground first:  sudo -u bots node /home/bots/x1-sonar/indexer.js
   → expect "slot N | X slots/s | Y interactions | at tip" lines every ~10s
6. Ctrl-C, then install the unit:
   sudo cp sonar-indexer.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now sonar-indexer
7. Verify:  journalctl -u sonar-indexer -f
8. After a few minutes:
   sudo -u postgres psql -d echohound -c "SELECT program_id, tx_count_all FROM sonar.programs ORDER BY tx_count_all DESC LIMIT 10;"

## Design notes
- Votes + ComputeBudget filtered at ingest (they'd dominate every metric)
- Checkpoints every 25 slots; replay-safe (unique program_id+signature, tested)
- Never outruns confirmed tip; paced (CATCHUP_DELAY_MS) to protect the validator
- Raw interactions retained ~8 days (aggregator, Step 3, handles rollup + pruning)

## Methodology note — Sonar Score

The Sonar Score ranks each program by its activity over the **trailing 30
days**, combining:

- **transaction volume** (log-scaled),
- **unique signers** (log-scaled, weighted highest),
- a **7-day liveness decay** (how recently it was last active), and
- an **age bonus** (established programs edge out brand-new ones).

Volume and signers are normalized to the chain max, so the score is relative:
a program's rank reflects how it stacks up against the busiest program on X1,
not an absolute count.

## Methodology note — v2 (CPI capture)

As of v2, the indexer credits programs invoked via **inner instructions
(CPIs)**, not just top-level instructions. Rationale: composable programs —
oracles, routers, token engines — are consumed *by other programs* on behalf
of end users. Counting only direct invocations made their real usage
invisible. With CPI capture, a user minting an NFT whose contract pulls
on-chain randomness credits the oracle with that user's signature too.

Applies evenly to every program, from deployment of v2 forward (history is
not rescanned). Expect infrastructure programs (SPL Token, ATA) to rise —
that is accurate: they are genuinely the most-used programs, and the SYSTEM
badge + "Apps only" toggle keep them distinguishable.

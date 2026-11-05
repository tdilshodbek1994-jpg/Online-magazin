# Operator Centre — load run (spec §32)

Measured result, not a production guarantee. Disposable database, synthetic data only.

## Setup

* DB: `scripts/load/prepare.sql` (10 000 SKUs, **100 000 historical orders**) + `scripts/load/ops-prepare.sql` (**1 000 orders awaiting confirmation** → 1 000 open tasks).
* Run: `DATABASE_URL=… API_URL=http://localhost:4000 OPERATORS=30 DURATION_S=45 node scripts/load/ops.mjs`
* Each of **30 parallel operators** loops: first screen (`GET /ops/center`) → take next (`POST /ops/center/next`) → record a result (`/contact`) → return the task (`/release`).
* Environment (2026-11-04): Claude cloud sandbox, 4 vCPU, 15 GB RAM, PostgreSQL 16, API via `tsx` (not the compiled build), API + DB + load generator on the same machine, no cache in front.

## Result (45 s)

| Call | p50 | p95 | Target p95 |
|---|---|---|---|
| First screen / queue (`GET /ops/center`) | 109 ms | 166 ms | ≤ 800 ms |
| Take next (`POST /ops/center/next`, claim) | 124 ms | 175 ms | ≤ 500 ms |
| Record result (`/contact`) | 50 ms | 79 ms | — |

* 3 329 full work cycles, **0 server errors (5xx)**, **0 double-hold violations** (a task was never held by two operators), 1 expected `409` (lost race, handled).

## Caveats

* Same-machine run; network latency to real users is not included. Re-run on the target server before relying on these numbers.
* Restore drill (`scripts/restore-drill.sh`) must be run separately on an environment isolated from production.

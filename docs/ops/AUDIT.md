# Operator Centre 3.0 — audit and P0 status

Spec: `OPERATOR_MARKAZI_CLAUDE_TEXNIK_TOPSHIRIQ.txt` (v1.0, 2026-11-04).
Repo: `tdilshodbek1994-jpg/Online-magazin`. Branch: `claude/online-marketplace-platform-sdtv52`. Nothing here is merged to `main` or deployed by Claude.
TAQVIM was not touched (§01, §29).

## 1. What existed before this work (verified in code and tests)

| Area | Status | Where |
|---|---|---|
| Order queues for operators (new, callback, partner-assisted, payment, pick, delivery, problem, returns, closed) | works | `GET /ops/queues`, `GET /ops/orders` — `apps/api/src/modules/orders/routes.ts` |
| Atomic order claim (conditional UPDATE) | works | `POST /ops/orders/:id/claim` |
| Call result on an order (confirmed / no answer / rejected / wrong data / call later) with total read-back | works | `POST /ops/orders/:id/calls` → now `logOrderCall()` |
| Address edit with `expected_version` (409 on stale) | works | `PATCH /ops/orders/:id/address` |
| Internal notes, cancel, pick/pack/ship, amendments (revision + re-confirmation), returns | works | orders, amendments, returns modules |
| Partner-assisted drafts, customer fill link (scoped, expiring, GET does not confirm) | works | `modules/partners/drafts.ts` |
| Quantity-tier commission (1/2/3 → 30 000 / 37 500 / 52 500), immutable ledger, reprice on return | works | `modules/commissions/service.ts`, tests `n-ad-analytics` |
| Separate staff layout (no shop banner/cart for partner cabinet) | partial | `components/Header.tsx` (partner); ops still uses the shop header |
| Tasks separate from orders, shifts, next-work, lease, callback not-before, five-answer card | **missing** → P0 below |
| Supervisor board, SLA clocks, handoff, routing by skill, outbox per audience, KB, AI assist, telephony adapter | missing → P1–P3 |

## 2. Done in P0 (this change)

Vertical slice UI → API → DB → tests:

* **DB** `migrations/0015_ops_center.sql` (additive): `staff_shifts`, `ops_tasks` (type, state, priority, reason, team, assignee, lease, due, not_before, next_action, blocked_by, source, attempts, version), `ops_task_events`; richer `call_logs.outcome`; `call_logs.task_id`.
* **API** `apps/api/src/modules/opscenter/routes.ts`:
  * `GET /ops/center` — shift, my tasks with the five answers, counts (available, callbacks due, overdue, blocked, unowned).
  * `PUT /ops/center/shift` — working / break / busy / off. Only *working* takes new work; break keeps active tasks (T13).
  * `POST /ops/center/next` — atomic `FOR UPDATE SKIP LOCKED`; my due callbacks first, then priority, then longest wait (aging); workload limit.
  * `POST /ops/center/tasks/:id/claim|heartbeat|release` — lease (15 min) + version fencing (T07, T10).
  * `POST /ops/center/tasks/:id/contact` — results: no answer, busy, wrong number, callback requested (exact time required), info given, confirmed (total read-back via the existing path), rejected, problem (reason required). A result always ends in a next action or a final reason (T18); attempts limit → blocked for a supervisor.
  * `GET /ops/center/tasks/:id` — card: five answers, order, task history, call history.
  * `GET /ops/center/board` — supervisor list + operator shift/active load (needs `orders.reassign`).
  * Confirm tasks are created idempotently for every order awaiting confirmation and closed automatically when the order moves on (T02).
* **UI** `apps/web/app/ops/WorkDesk.tsx` on `/ops`: shift switch, honest counters (only non-zero warnings), "Keyingi ishni olish", my task list, task card (five answers, `tel:` that only opens the phone app, read-back checkbox before "Tasdiqladi", callback time in Asia/Tashkent, internal note label, history).
* **Tests** `apps/api/test/q-ops-center.test.ts` on real PostgreSQL: T02, T07, T10/T12, T13, T15, T18, confirm through task, permission denial.

## 3. Not done yet (honest list)

P1: skill/language routing and capacity round-robin, handoff request/accept, SLA clocks with business calendar and pause reasons, partner requests into tasks, customer-safe vs internal message composer, notification outbox per audience, staff layout for `/ops` without shop header.
P2: supervisor dashboard UI (API exists), incident grouping, QA sampling, duplicate review, bulk-safe actions, KB/templates, load and restore tests.
P3: real telephony adapter, Telegram Business, AI assistant (read-only, human approval).

## 4. Policy register (owner decisions pending — no hidden production defaults)

| Policy | Current value | Status |
|---|---|---|
| Claim lease | 15 min, heartbeat every 5 min | demo default, owner to approve |
| Max active tasks per operator | 5 | demo default |
| Unanswered call attempts before supervisor | 5 | demo default |
| Default retry after "no answer" | +2 h unless the operator sets a time | demo default |
| Confirm task due | order created + 30 min | demo default, not shown to customers |
| Contact hours / quiet hours / opt-out | not enforced yet | **owner decision needed** (P1) |
| 4+ units quantity tier | not invented; manual review | **owner decision needed** |

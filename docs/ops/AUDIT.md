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

## 2b. Done in P1 (part 1)

* **Handoff** (`migrations/0016_ops_handoff.sql`, `modules/opscenter/handoff.ts`): request with a package (done, customer said, promised, missing, next, deadline) → accept / decline (reason) / cancel; one pending per task; expires after 30 min back to the sender; the sender stays owner until accept (T14). UI: incoming handoffs with the package on "Mening ishim", form in the task card.
* **Supervisor transfer** `POST /ops/center/tasks/:id/assign` (needs `orders.reassign`, reason required, audited, history kept). UI: `/ops/board` — operators with shift and active load, filters (attention, blocked, unowned, overdue, callbacks, all), oldest unowned item, transfer per row.
* **Contact hours** 09:00–21:00 Asia/Tashkent: a callback cannot be set outside them (`OUTSIDE_CONTACT_HOURS`, T16); automatic retries move to the next 09:00.
* Waiting time counts from when the order came in (not from when the task row was created).
* Tests `r-ops-handoff.test.ts`: T14, handoff expiry, supervisor transfer permission + audit, T16.

## 2c. Done in P1 (part 2): partner requests

* `migrations/0017_partner_order_requests.sql`, `modules/opscenter/partnerRequests.ts`.
* Partner (sales passport → "Operatorga yozish"): message, callback time (exact time required), address, variant change, commission question. Scoped to the partner's own orders (other partners get 404, T04).
* All requests of one order join one open `partner_request` task (no duplicate cases). Operator answers in the task card; the partner sees only that answer, no staff identity. When every request is answered the task resolves; a requested call time updates the order's callback.
* Test `s-partner-requests.test.ts`.

## 2d. Done in P1 (part 3)

* **Staff layout**: `/ops`, `/admin`, `/courier` use a compact staff bar (sections, profile menu) — no shop search, banner or cart (§05).
* **SLA levels** on every active task: ok / soon (≤10 min) / late / critical (>2 h past due); waiting and scheduled tasks are paused (real age kept). A critical task is escalated once (priority +1, `sla_escalated` event, visible on the board under "Jiddiy kechikkan") without bumping the version, so an open card still saves.
* **Three-audience messages** (`migrations/0018_order_messages.sql`, `modules/opscenter/messages.ts`): composer names the audience (🔒 internal / 🤝 partner / 👤 customer) before sending; internal notes stay in `order_notes`; partner messages show on the sales passport (+ Telegram outbox), customer messages on the customer's order page (in-app notice for logged-in customers, no SMS from here). Delivery states: stored / queued / sent / failed / unknown — never "read" (T25).
* Tests: SLA in `q-ops-center.test.ts`, `t-order-messages.test.ts`.

## 2e. Done in P2

* **Saved replies** (`0019_reply_templates.sql`, `templates.ts`): Latin/Cyrillic, versioned (edit = new version, old retired), placeholders only from verified order data; an unfilled `{placeholder}` cannot be sent outside (`TEMPLATE_UNFILLED`). Composer picker per audience.
* **Duplicate review** (`0020_duplicate_review.sql`, `duplicates.ts`, T03): evidence list (same phone ±7 days, minutes apart, shared items, source); "not a duplicate" clears the signal for good; "duplicate" cancels this order with a canonical link (both IDs + histories kept); paid/shipped refused.
* **Bulk-safe transfer** (`bulk.ts`, T53): preview (dry run) → per-item execution, results and summary; only task transfer, no money actions.
* **Incidents** (`0021_ops_incidents.sql`, `incidents.ts`): one root cause links many tasks (they wait as "ichki muammo"); resolving returns them to the queue with a clear next action and never changes orders.
* **Operator quality** (`GET /ops/center/quality`): tasks contacted, confirmed (rate with denominator), rejected, median minutes to first contact; "ma'lumot kam" below 20 tasks; no ranking.
* **Product facts** on the task card: stock now, ordered vs current price, warranty ("va'da bermang" when unknown), description.
* **QA sampling** (`0022_ops_qa.sql`, `qa.ts`): random sample of finished tasks (14 days) for a human reviewer — never your own work (DB check); three checks + 1–5 score, reason required for ≤2; operator sees reviews and may object once (status → disputed); no automatic penalty.
* Tests: `u-reply-templates`, `v-duplicates`, bulk/incident/quality/QA in `r-ops-handoff`.

## 3. Not done yet (honest list)

P1 (remaining): skill/language routing and capacity round-robin, business calendar (holidays) for SLA, quiet-hours digest for notifications.
P2: load test done — see `docs/ops/LOAD.md` (100k orders, 1 000 open tasks, 30 operators: p95 166 ms queue / 175 ms claim, 0 errors, 0 double holds). Restore drill still to be run on an isolated environment.
P3: real telephony adapter, Telegram Business, AI assistant (read-only, human approval).

## 4. Policy register (owner decisions pending — no hidden production defaults)

| Policy | Current value | Status |
|---|---|---|
| Claim lease | 15 min, heartbeat every 5 min | demo default, owner to approve |
| Max active tasks per operator | 5 | demo default |
| Unanswered call attempts before supervisor | 5 | demo default |
| Default retry after "no answer" | +2 h unless the operator sets a time | demo default |
| Confirm task due | order created + 30 min | demo default, not shown to customers |
| Contact hours | 09:00–21:00 Tashkent | demo default, owner to approve |
| Handoff expiry | 30 min | demo default |
| SLA warning / critical | 10 min before due / 2 h after due | demo default |
| Opt-out / attempt spacing per customer | not enforced yet | **owner decision needed** |
| 4+ units quantity tier | not invented; manual review | **owner decision needed** |
| Partner customer discount (discount link) | paid from the partner's commission; max = commission per unit at link creation (and < price); commission never below 0 | demo default, owner to approve |

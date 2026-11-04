# Contest Center — handoff for the next session

- Branch: `claude/online-marketplace-platform-sdtv52` (push only here; no merge to main; no production deploy without the owner).
- Code: `apps/api/src/modules/contests/engine.ts` (score engine, ranking, funnel, Tashkent week), `apps/api/src/modules/contests/routes.ts` (API), registered in `apps/api/src/app.ts`.
- Changed: `apps/api/src/modules/partners/programs.ts` (`awardBonus` exported, `cc_prize` source), `apps/api/test/helpers.ts` (`setupIsolatedApp`).
- Migration: `apps/api/migrations/0025_contest_center.sql` (forward-only; runs automatically via om-migrate).
- API: admin `/admin/cc/contests[...]` (create, edit/revise, submit, approve, publish, pause, resume, cancel, recompute, simulate, close, finalize, award, corrections, export.csv), `/admin/cc/prizes/:id/award`, `/admin/cc/awards/:id`, `/admin/cc/appeals/:id/resolve`; partner `/partner/cc/contests[/:id, /join, /leave, /leaderboard, /me, /appeals]`, `/partner/cc/prizes`.

## Rules worth knowing
- Score = journal of deltas (`cc_score_events`), key `cc:<contest>:<order>:<n>` under a per-contest advisory lock. Never update/delete rows; corrections are rows with a reason.
- Provisional = delivered with kept units; final = delivered AND `payment_status in (paid, partially_refunded)`.
- Confirmed commission = accruals in `pending|available` for eligible lines (ledger recalcs returns).
- Refund ratio is shown only with ≥5 units of data; otherwise `null` (not used in tie-break).
- Ties beyond prize stock are returned as `needs_decision` — the owner awards explicitly (`/admin/cc/prizes/:id/award`).

## Next tasks (in order)
1. Web: admin editor (create/edit with reason, prizes, dry-run table, status buttons, appeals queue, awards) under `/admin` tab "Konkurs markazi".
2. Web: partner "Konkurs markazi" (list, detail+rules, join with consent toggles, leaderboard with as-of + warning, my result with counted orders, appeal form, my prizes).
3. P1: notifications (start, deadline, provisional, winner) via existing Telegram outbox with opt-in; fraud flags (self-referral, duplicates) into a review queue; contest ROI metric with "data incomplete" when ad spend is unknown (C13–C15); weighted formulas.
4. Two-step approval for large prizes (finance + owner); budget planned/committed/actual report.

## Blockers / owner decisions
- Prize tax / local contest law: needs a legal check before production (not a legal opinion).
- Default appeal window 3 days, min score 1, alias names by default — demo defaults, owner to confirm.

# UZSHOP PRO — Quality Center (warnings, order authenticity): status

Branch `claude/online-marketplace-platform-sdtv52` · not merged to main · not deployed without the owner.

## Audit findings (before this work)
- Partner-assisted orders already required the customer's own confirmation (SMS code + link `/confirm/:token`, confirm or reject) or an operator call; fulfilment is impossible before confirmation. **Reused, not rebuilt.**
- Gap: a partner who also had the operator role could confirm their own order → **fixed** (`SELF_CONFIRMATION_FORBIDDEN`).
- Gap: courier failures had no fault → **added** `shipments.failure_fault` (courier/warehouse/operator faults never count against the partner).
- Gap: money penalties (`/admin/penalties`) worked without any legal gate → **now blocked** unless an active policy has `monetary_enabled` + legal approval AND flag `quality.monetary_penalties` is on.
- Commission reversal on returns is a ledger accrual movement, separate from `penalties` (verified by test Q14).

## P0 — done
| Item | State |
|---|---|
| Migration `0026_quality_center.sql` (policies, cases, warnings, restrictions, appeals, courier fault, flag) | done |
| Explained metrics: confirmation, delivery, customer denial, verified invalid — numerator/denominator/period/timezone/sample/excluded | done |
| Policy: one admin-chosen metric + threshold + min sample; signal only (never automatic fault or money) | done |
| Customer "I did not order" (existing OTP reject) → order cancelled, never shipped, case opened for a human | done |
| Risk inbox (metric signals, same-phone signals, open cases) | done |
| Case workflow with optimistic version, fault required for violation, inconclusive ≠ fault, audit old/new + reason + actor | done |
| Warning once per case (level escalates per partner), restriction only after an earlier warning, idempotent | done |
| Partner: own metrics, warnings, restrictions, cases, reply, appeal; other partner's case = 404 | done |
| Contest finalization blocked while a quality case on contest orders is open | done |
| Admin tab «Sifat markazi», partner page `/partner/quality` (dashboard tile «Sifat») | done |

## Tests
- `apps/api/test/zc-quality-center.test.ts` on its own database `om_test_quality`: Q01, Q02, Q03, Q04, Q05, Q06, Q07, Q08, Q09, Q10, Q11, Q12, Q13, Q14, Q17, Q18, Q19, Q20.
- Full run 2026-11-04: `cd apps/api && pnpm vitest run` → 28 files, 202 tests passed, exit 0. Web E2E 15/15.
- Not yet tested as separate cases: Q15 (finalize block exists in code; contest test for it is P1), Q16 (one order = one attribution = one score row — covered by contest journal design, no dedicated test).

## Rollback
Forward-only migrations. To disable: set flag `quality.monetary_penalties=false` (default), retire the active policy (`UPDATE quality_policies SET status='retired'`). New tables can stay empty; nothing else depends on them except the contest finalize check (no open cases ⇒ no effect).

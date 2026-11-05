# Quality Center — handoff

- Code: `apps/api/src/modules/quality/routes.ts` (metrics `rates/partnerRates`, `signalFor`, `assertMonetaryPenaltyAllowed`, `openDeniedCase`, admin + partner API). Wired in `apps/api/src/app.ts`.
- Touched: `orders/routes.ts` (self-confirmation guard, courier `fault`), `orders/service.ts` (confirmOrder method type), `partners/routes.ts` (customer reject → case), `partners/programs.ts` (money penalty gate), `contests/routes.ts` (finalize blocked by open cases), `test/k-programs.test.ts` (creates a legally approved policy before the old penalty test).
- Web: `apps/web/app/admin/QualityCenter.tsx`, `apps/web/app/partner/quality/page.tsx`.
- Migration `0026_quality_center.sql` also widened `order_confirmations` method/status checks (`customer_link`, `denied`, `disputed`, `unreachable`) for the next step; P0 uses the existing `customer_otp` flow.

## Next (P1)
1. UI for restrictions (create/lift), appeal queue for admins, evidence upload, policy editor + legal approval form (API exists).
2. Enforce restrictions: `assisted_orders_paused` should block `POST /partner/orders`; `extra_verification` should force OTP for every assisted order; `contest_review` should hold contest awards.
3. Operator QA link (existing ops QA) into cases; partner Telegram notice on warning (opt-in).
4. Tests for Q15/Q16.
5. P2 only after contract + legal approval: monetary penalties UI.

## Owner decisions
- Choose the metric/threshold/min-sample for the first policy (demo suggestion: confirmation rate < 30%, min 20 resolved, 30 days) — create via `POST /admin/quality/policies` (owner).
- Money penalties: need contract version + lawyer approval first.

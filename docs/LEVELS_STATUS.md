# Partner Level & Loyalty PRO — status

Branch `claude/online-marketplace-platform-sdtv52` · not merged · not deployed without the owner. Plan written first: `docs/LEVELS_PLAN.md`.
"SB coins" in the task = the existing UzCoin system (reused, not rebuilt).

| Item | State |
|---|---|
| Migration `0037_partner_levels.sql`: 20 level definitions from the task (names, thresholds), versions, state, history, adjustments, benefit products, one coupon per partner, promos, gift-order discount snapshot | done |
| Units = qualified units from the UzCoin ledger (commission available ⇒ confirmed, delivered, payment verified, hold passed) + audited adjustments; cancelled orders never count, returns subtract, each sale counted once (ledger unique keys); recomputed in the same transaction (advisory lock per partner) | done |
| 10 000 units → one-time 50% coupon (available → armed → reserved by next eligible order → used when that order's commission is available; cancel/no earnings → back to armed; below threshold unused → void; never a second coupon) | done |
| 100 000 units → VIP: 50% on every new line of an eligible product | done |
| 50% only for owner-approved products, only if unit net − cost − 50% ≥ 0 (cost known), only if higher than the base; matrix coefficients (100/50/25) kept; versioned snapshot per order line — old orders never change | done |
| Gift shop: level discount on every card (original price, level, %, final, saved), final price reserved atomically (row locks, CHECK ≥ 0, Idempotency-Key), snapshot on the gift order | done |
| Partner page `/partner/level` (badge, progress, perks, coins, gift discount, coupon, VIP, history, rank, advice) + tile in the cabinet | done |
| Admin tab «🎖️ Darajalar»: level table (names/thresholds/badges/colours/discounts, versioned + audited + partners recomputed), 50% products, dispute adjustments, promos, coupons, TOP | done |
| Advice («AI») = analysis of trend, top products, cancel rate, activity, remaining units; never changes money/benefits; LLM provider stays off (`ai.enabled=false`) | done |

## Policy register (demo values — owner approves)
- Gift discount per level: 0%, 1%, 2% … 9% (level 9), 10% (Elita, from the task's example) … 18%, 20% (UzShop Legend). Admin can change.
- Coupon rate 50% and thresholds 10 000 / 100 000 are the task's values (constants in `levels/service.ts`).

## Tests
- `apps/api/test/zm-levels.test.ts` (own DB `om_test_levels`): task cases 1–12 + coupon release on cancel + margin refusal + advice (8 tests). 10 000 / 100 000 units are reached with audited adjustments plus a real sale crossing the threshold.
- Full run 2026-11-04: `cd apps/api && pnpm vitest run` → 38 files, 293 tests passed, exit 0.

## Rollback
Additive only. Turn off: disable all benefit products (no 50%), set gift discounts to 0. Level tables can be dropped without touching orders, commissions or coins.

## Next
- Optional: notify the partner (Telegram/in-app) on level up and coupon issue.
- Owner decisions: real gift-discount table; which products get 50%; enter `cost_minor` for those SKUs (without cost the 50% is never applied).

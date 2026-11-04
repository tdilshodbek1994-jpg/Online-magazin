# UZSHOP Partner Level & Loyalty PRO — integration plan

Written before any code change (task §10). "SB" in the task = the existing **UzCoin** system (ledger, balances, gift shop) — reused, not rebuilt.

## Existing modules found
| Need | Existing piece | How it is reused |
|---|---|---|
| Qualified units (delivered + settled, minus cancel/return, idempotent) | `uzcoin_ledger` rows `earned_sale` / `return_adjustment` with signed `qty`, unique `(source_type, source_id, effect_key)`; written by `syncOrderCoins` only when the line's commission is **available** (confirmed, delivered, payment verified, hold passed); unverified partner-assisted orders earn nothing | Level units = Σ qty of those rows + audited admin adjustments. One sale can never count twice (ledger uniqueness). Returns lower the count automatically. |
| Commission engine (base model per product, quantity matrix 100/50/25, versioned rule snapshot per order line) | `commissions/service.ts` — `ruleForProduct`, `computeOrderTargets`, `accrueForOrder`, `recalcOrder`; `order_lines.commission_rule_snapshot` | A level benefit only changes the **snapshot written for a new order line** (`benefit` field). Old orders never change; returns/cancels recompute from the same snapshot; matrix coefficients stay. |
| Gift shop + atomic coin spending | `uzcoin_gifts`, `uzcoin_gift_orders`, `post()` with row locks, CHECK available ≥ 0, Idempotency-Key | Discount = level percentage applied to the gift price at order time; snapshot of base price, level and discount on the gift order. |
| Audit | `platform/audit.ts` | Every admin change, adjustment, level change and coupon move. |
| AI | flag `ai.enabled` (off) | Advice is a deterministic analysis; never touches money/benefits. |

## New (migration 0037, additive)
- `partner_level_defs` (20 rows from the task: 0 Boshlovchi … 19 UzShop Legend; badge, colour, gift discount bps — **demo** discounts, owner approves) + `partner_level_def_versions` (snapshot per admin change).
- `partner_level_state` (units, level, vip_since), `partner_level_history`, `partner_level_adjustments` (disputes, ± units with reason).
- `level_benefit_products` (admin chooses which products may get 50%; margin check uses `skus.cost_minor`).
- `partner_commission_coupons` (one per partner at 10 000 units: available → armed → reserved(order) → used; cancel/full return → back to armed).
- `level_promos` (time-boxed extra gift discount from a minimum level, total capped at 50%).
- `uzcoin_gift_orders` + `base_price_coins`, `discount_bps`, `level_snapshot`.

## Rules
- Level = highest threshold ≤ units. Recomputed in the same transaction after every coin-ledger change for that partner (advisory lock per partner) and after admin threshold changes.
- 10 000 units → one coupon (unique per partner). Below 10 000 again before use → coupon voided; crossing again re-activates the same coupon (never a second one).
- 100 000 units → VIP: every new order line of an eligible product gets 50%.
- 50% = unit base commission (percent model: 50% of line net; fixed/matrix: base = 50% of unit net), matrix coefficients still apply. Applied only if unit net − cost − 50% unit ≥ 0 and cost is known; otherwise the normal rule stays and the reason is stored.
- Coupon is reserved by the next eligible order while armed; counted as used only when that order's commission becomes available.

## Tests (own DB) — acceptance 1–12 of the task
49/50/100/500 levels, 10 000 coupon, 100 000 VIP, cancelled order not counted, returned unit removed, no double count, gift discount, coupon single use, admin audit. Units for 10 000/100 000 are reached through audited admin adjustments + one real sale crossing the threshold.

## Rollback
Additive tables/columns only; disabling = admin sets benefit products off (no 50% applied) and gift discounts to 0; level data can be dropped without touching orders, ledger or coins.

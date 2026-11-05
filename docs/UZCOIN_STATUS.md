# UZSHOP PRO — UzCoin Rewards Engine: status

Branch `claude/online-marketplace-platform-sdtv52` · not merged to main · not deployed without the owner.

## Design
- Separate immutable coin ledger (`uzcoin_ledger`, trigger forbids update/delete, unique source/effect key) + derived balances (`uzcoin_balances`, `available >= 0`). Does not touch the money wallet; exchange money enters the wallet only on approval, then the **existing payout flow** sends it.
- Coins: 1 kept unit of a line whose commission is AVAILABLE (confirmed, delivered, payment verified, hold/return window passed) = 1 coin. Commission size never changes the count. Unconfirmed proxy orders earn nothing.
- Hooks: issued in `releaseMatured` (commission becomes available), adjusted in `recalcOrder` (returns). Deltas only; a return that cannot be taken back yet becomes visible `debt`, repaid from next earned coins.
- Rate: versioned `uzcoin_rates` (v1 = 3 000 so'm). Exchanges store rate version + snapshot amount. Gift prices are independent of the rate.
- Gift shop separate from the catalog; order locks the gift row (stock-safe), checks balance and per-partner limit, snapshots price, reserves coins. Delivered → spent; canceled (before shipping) → coins and stock back.
- Contest prizes in UzCoin: prize kind `uzcoin`, ledger source `cc_award`, once per award.
- Penalties never touch coins automatically; charity from coins not implemented (spec: later, separate operation).
- AI: no endpoint can create coins, change balances, move money or prices.

## Done
Migration `0029_uzcoin.sql`; `apps/api/src/modules/uzcoin/{service,routes}.ts`; hooks in `commissions/service.ts`; contest coin prize in `contests/routes.ts`; partner page `/partner/uzcoin` (tile «🪙 UzCoin» replaced «Bonuslar»); admin tab «🪙 UzCoin» (report, exchanges, gift orders, gift catalogue, rate); contest editor can set UzCoin prizes.

## Tests
- `apps/api/test/ze-uzcoin.test.ts` (own DB `om_test_uzcoin`, real order flow): #1–#19 (7 test groups).
- Full run 2026-11-04: `cd apps/api && pnpm vitest run` → 30 files, 215 tests passed, exit 0. Web E2E 15/15.
- Demo data: running `src/demo/fill.ts` issues coins through the real hooks (101 coins in the local demo).

## Not done / owner decisions
- Admin gift editor is basic (title, description, price, stock, cost, delivery, one image link); variants/kit/videos/category fields exist in the API, not yet in the form.
- AI explanations (read-only) not built.
- Rate changes and the cash value are a legal/finance decision (liability = available + reserved × current rate, shown separately from shop profit).

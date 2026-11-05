# UZSHOP PRO — Charity Center: status

Branch `claude/online-marketplace-platform-sdtv52` · not merged to main · not deployed without the owner.

## Audit (before)
- Existing "Hayriya qutisi": one-time gift from available balance (`charity_donations`, ledger `available → external`, journal `partner_payable → charity_fund`), admin handovers (`charity_handovers`). **Reused — no second balance.**
- Balance row has `CHECK (available_minor >= 0)`: payout reservation and charity can never spend the same money.
- Fixed: the one-time gift's idempotency check ran before the balance lock (a double click could pass twice) → now after the lock.

## Done (P0 + automatic share from P1)
| Item | State |
|---|---|
| Migration `0028_charity_center.sql`: funds, partner rules (consent), donation source/status/fund/accrual link, disbursement status/proof/two approvers | done |
| Automatic % of the partner's **own confirmed commission**, applied when it becomes available (hook in `releaseMatured`), once per accrual | done |
| Default OFF; explicit consent (version recorded); pause/resume/cancel; changes never alter past entries; monthly cap | done |
| Unconfirmed proxy (partner-assisted) orders give no share | done |
| One rounding policy (half-up to the tiyin): 300 000 × 1% = 3 000; 37 500 × 1% = 375 | done |
| Funds draft → review → approved (owner, recipient + requisites required) → paused/closed | done |
| Collected (to fund) ≠ disbursement pending ≠ disbursed (with proof); ≥ 10 000 000 so'm needs a second, different approver | done |
| No admin endpoint can switch on a partner's giving (by design, tested) | done |
| Partner page `/partner/charity` (totals, one-time, automatic with presets 0.5/1/2/5%/custom + example, history, funds); admin tab «Xayriya markazi» | done |

## Tests
- `apps/api/test/zd-charity-center.test.ts` (own DB `om_test_charity`), real flow order → confirm → delivered → COD remitted → commission available: #1, #2, #3, #4, #5, #6, #7, #9, #10, #11, #12, #13, #14, #15.
- Full run 2026-11-04: `cd apps/api && pnpm vitest run` → 29 files, 208 tests passed, exit 0. Web E2E 15/15.
- Not done: #8 (refund after a gift was made: currently the gift stays as is, no automatic correction — policy needed, see handoff).

## Rollback
Forward-only migration; rules default to none, so nothing is deducted unless a partner turns it on. To stop all automatic giving: `UPDATE charity_rules SET status='paused'`.

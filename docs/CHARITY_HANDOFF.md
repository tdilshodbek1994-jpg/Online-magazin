# Charity Center — handoff

- Code: `apps/api/src/modules/charity/service.ts` (`share`, `applyCharityAuto`), `apps/api/src/modules/charity/routes.ts` (partner + admin API), hook in `commissions/service.ts → releaseMatured`, one-time gift in `partners/programs.ts` (`fund_id`, idempotency after lock). Web: `apps/web/app/partner/charity/page.tsx`, `apps/web/app/admin/CharityCenter.tsx`.
- API: partner `GET /partner/charity/center`, `GET /partner/charity/preview`, `PUT /partner/charity/rule`, `POST /partner/charity/rule/{pause|resume|cancel}`, `POST /partner/charity` (Idempotency-Key); admin `GET /admin/charity/center`, `POST /admin/charity/funds`, `POST /admin/charity/funds/:id/status`, `POST /admin/charity/disbursements`, `POST /admin/charity/disbursements/:id/confirm`.

## Next
1. Refund/chargeback after a gift (#8): decide the policy (recommended: never claw back a gift already moved to the fund; record a visible "adjustment needed" item for finance instead) and implement with audit.
2. Reconciliation report: sum(charity_donations) vs journal `charity_fund`; CSV export without personal data.
3. Opt-in Telegram notice when a share is made; optional AI explanation (read-only).
4. Shop-funded charity (owner contribution) as a separate source — never mixed with partners'.

## Owner / legal
- Two-step threshold (demo 10 000 000 so'm), recipient organisations, requisites, tax and contract requirements — legal review before production. No tax benefit or religious ruling is promised anywhere.

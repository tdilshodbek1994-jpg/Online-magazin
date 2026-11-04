# Partner Level & Loyalty PRO — handoff
- Code: `apps/api/src/modules/levels/{service,routes}.ts`; hooks: `orders/service.ts` (benefit snapshot on new lines), `uzcoin/service.ts` (`syncOrderCoins` → coupon + level sync), `uzcoin/routes.ts` (gift discount). Web: `apps/web/app/partner/level/page.tsx`, `apps/web/app/partner/uzcoin/page.tsx` (gift cards), `apps/web/app/admin/LevelsAdmin.tsx`.
- Migration `0037_partner_levels.sql` (additive). Tests `apps/api/test/zm-levels.test.ts`.
- Next single task: level-up / coupon notifications to the partner (in-app + Telegram) through the existing notification queue.

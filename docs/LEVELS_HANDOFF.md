# Partner Level & Loyalty PRO — handoff
- Code: `apps/api/src/modules/levels/{service,routes}.ts`; hooks: `orders/service.ts` (benefit snapshot on new lines), `uzcoin/service.ts` (`syncOrderCoins` → coupon + level sync), `uzcoin/routes.ts` (gift discount). Web: `apps/web/app/partner/level/page.tsx`, `apps/web/app/partner/uzcoin/page.tsx` (gift cards), `apps/web/app/admin/LevelsAdmin.tsx`.
- Migration `0037_partner_levels.sql` (additive). Tests `apps/api/test/zm-levels.test.ts`.
- Notifications: level-up (once per reached level, none on downgrade) and coupon issue (once) via the existing partner queue (Telegram + cabinet list).
- Next single task: owner decisions (gift discount table, 50% products + SKU costs).

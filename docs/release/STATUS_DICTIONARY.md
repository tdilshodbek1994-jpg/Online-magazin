# Order status dictionary (one name per state, every cabinet)

Order states are independent: commercial (order), confirmation (customer), fulfilment (shipment), payment, return,
commission, payout, UzCoin. The lists below are the **display buckets** derived from them; «Yetkazildi» never means
«all money settled».

| Bucket key | Name everywhere | Derived from (`BUCKET_SQL`, `partners/cabinet.ts`) | Customer page |
|---|---|---|---|
| new | Yangi | not confirmed yet | «Yangi» (+ hint: tasdiqlanmoqda) |
| accepted | Tasdiqlandi | commercial=confirmed & confirmation=verified | «Tasdiqlandi» |
| — | Yig‘ilmoqda | fulfilment picking/packed (customer step only) | «Yig‘ilmoqda» |
| shipping | Yo‘lda | fulfilment=shipped | «Yo‘lda» |
| delivered | Yetkazildi | fulfilment=delivered or commercial=completed | «Yetkazildi» |
| returned | Qaytarildi | fulfilment returned/failed | «Qaytarildi» / «Yetkazib bo‘lmadi» |
| cancelled | Bekor qilindi | commercial=cancelled or confirmation rejected/expired | «Bekor qilindi» |

Separate statuses shown separately: payment (`To‘landi`, `Olganda to‘laysiz`, …), return request (`So‘rov qabul qilindi` → `Yakunlandi`), refund (`Pul qaytarildi`, `Pul holati tekshirilmoqda`, …), commission (estimated/pending/available), payout.
Source files: `apps/web/app/partner/shared.tsx` (BUCKET_LABEL), `apps/web/app/admin/AdminOrderList.tsx`, `apps/web/lib/orderStatus.ts`, `apps/api/src/modules/selfservice/routes.ts` (customerStage), `apps/api/src/modules/aibiz/*`.

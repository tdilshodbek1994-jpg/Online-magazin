# Пул журнали

## 1. Компания журнали (`journal_transactions` / `journal_entries`)
Immutable; ҳар транзакция deferred constraint trigger билан дебет=кредит (бир валюта). `business_event_key` UNIQUE — retry иккинчи пул яратмайди.
| Воқеа | Дебет | Кредит |
|---|---|---|
| COD топширилди (`cod_collected:<order>`) | courier_cash | sales_clearing |
| COD кассага тушди (`cod_remitted:<rem>`) | cash_bank (received) | courier_cash (min(received, expected)); ортиқча → suspense |
| Онлайн capture (`capture:<attempt>`) | psp_receivable | sales_clearing |
| Ортиқча тўлов | psp_receivable | suspense |
| Refund (`refund:<id>`) | sales_clearing | cash_bank ёки psp_receivable |
| Комиссия available | commission_expense | partner_payable |
| Комиссия сторно (available'дан) | partner_payable | commission_expense |
| Payout тўланди (`payout_paid:<id>`) | partner_payable | cash_bank |
Кам топширилган COD фарқи `courier_cash` қолдиғида кўринади (яширилмайди).

## 2. Ҳамкор журнали (`partner_ledger`)
Bucket'лар ўртасида ўтказма: `external, estimated, pending, available, reserved, paid, debt`. UNIQUE `(source_type, source_id, effect_key)` — ҳар бизнес таъсир бир марта. `partner_balances` — проекция (CHECK: available/reserved ≥ 0, debt ≤ 0), `GET /admin/partners/:id/ledger-check` журналдан қайта қуриб солиштиради.
- payout сўрови: available → reserved (атомар, параллел сўровда биттаси ўтади)
- рад: reserved → available; тўланди: reserved → paid; номаълум: ўзгармайди + exception
- тўлангандан кейин refund: available'дан етганича, қолгани debt → external (қарз кўринади)

## 3. Инвариантлар (тест билан)
INV05 жами=сатрлар (`checkout_quotes` CHECK) · INV08 баланс (trigger) · INV09 refund ≤ captured (CHECK) · INV10 payout ≤ available (CHECK) · INV11 бир сатр — бир live accrual (partial unique) · INV18 replay қайта ижро қилмайди (UNIQUE event keys).

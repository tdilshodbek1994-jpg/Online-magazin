# Бизнес қоидалари ва policy реестри

Барча рақамли қийматлар `business_policies` жадвалида версияланади. Demo fixture'лар `status=draft, is_demo=true` — **production'да ҳисобга олинмайди** (`getPolicy`); production учун owner `POST /admin/policies` → `/approve` қилиши керак.

| Key | Demo қиймат | Production шарти |
|---|---|---|
| attribution.window_days | 30 | owner тасдиғи; тасдиқсиз click attribution ўчиқ (фақат қўлда код) |
| commission.hold_days | 14 | тасдиқсиз автоматик release санаси қўйилмайди |
| payout.min_minor | 10 000 000 (100 000 сўм) | тасдиқсиз payout сўрови рад этилади (`PAYOUT_POLICY_NOT_APPROVED`) |
| payout.approval_mode | two_person | `owner_only` фақат аниқ тасдиқланса, аудитда кўринади |
| partner_order.confirmation_ttl_hours | 24 | — |
| legal.offer_version | offer-v1-draft | ҳуқуқий текширувдан ўтган матн |
Етказиш тарифи: `delivery_zones` (demo: Тошкент шаҳри, 20 000 сўм, 1–2 кун).

## Attribution
1. Checkout'да мижоз киритган ҳақиқий ҳамкор коди — устувор. Нотўғри код → validation хатоси.
2. Акс ҳолда ойна ичидаги охирги eligible referral босиши (visitor token ёки user_id).
3. Bot/preview, ўчирилган ҳавола/кампания, suspended ҳамкор → touch `eligible=false`; харидор барибир харид қилади, комиссия йўқ.
4. Self-referral → `eligible=false, ineligible_reason=self_referral_review`.
5. Order яратилганда `orders.attribution` ва `order_lines.attribution_snapshot` қотирилади; кейинги click ўзгартирмайди.
6. Тузатиш фақат `partners.manage` + сабаб + далил; эски accrual `superseded` бўлиб қолади.

## Ҳамкор мижоз номидан буюртма
- partner_id ҳар доим аутентификациядан; payload'даги partner_id эътиборсиз.
- Буюртма `awaiting_confirmation`; қолдиқ банд қилинмайди.
- Мижоз SMS ҳавола + 6 рақамли код билан тасдиқлайди (бир марталик, муддатли, 5 уриниш) ёки оператор қўнғироқ қилиб **айнан жами суммани** қайтариб тасдиқлайди.
- Тасдиқ сессия бермайди. Рад → `cancelled`, комиссия 0.
- Бир телефон + бир SKU 48 соат ичида → `duplicate_signal`, оператор ҳал қилади; ҳамкорга маълумот очилмайди.

## Комиссия
- Ҳар маҳсулотга `percent` ЁКИ `fixed_per_unit` (иккаласи эмас), версияланган, тарихий қоида ўзгармайди (триггер).
- База: чегирмадан кейинги товар суммаси (tax-included), етказиш киритилмайди.
- Target формуласи (бир формула, икки марта сторно йўқ): percent = round(bps × (line_net − refunded_product)/10000); fixed = fixed × retained_qty × (retained_base − value_refund)/retained_base.
- `estimated` (order) → `pending` (тасдиқланган + delivered + тўлов settled: online paid ёки COD молия тасдиқлаган) → `available` (hold ўтгач, очиқ қайтариш/низо йўқ).
- Эталонлар (тест fixture, тариф эмас): fixed 30 000 × 2 = 60 000; 1 та қайтса 30 000. 30% ва 90 000 база = 27 000.

## Тўлов ва refund
- COD: delivered ≠ paid. Курьер → remittance → молия `received` билан тасдиқлайди; фарқ `finance_exceptions`.
- Онлайн: фақат провайдер callback'и; return URL далил эмас. Иккинчи ҳақиқий тўлов → `excess_payments` + exception.
- Refund: сўровчи тасдиқлай олмайди; `refunded + reserved ≤ captured` CHECK; `unknown_result` — резерв сақланади, қайта уриниш иккинчи марта қайтармайди.

## Тасдиқланган буюртмани ўзгартириш (T050)
Оператор янги таркибни таклиф қилади → сервер янги quote → мижозга бир марталик SMS ҳавола+код. Мижоз тасдиқламагунча буюртма эски ҳолатда, йиғиш/жўнатиш блокланган. Тасдиқда эски сатрлар `canceled` (snapshot сақланади), янги сатрлар, резерв ва комиссия қайта ҳисобланади. Тўланган буюртмани бу йўл билан ўзгартириб бўлмайди (refund оқими).

## Маркетинг (T087)
Кампания: тайёрловчи ≠ тасдиқловчи; аудитория — розилиги борлар; **юбориш пайтида** розилик қайта текширилади (кейин чиққанлар `suppressed`). Транзакцион хабарлар маркетинг розилигига боғлиқ эмас.

## AI (Stage F)
`ai.enabled` flag (default off), кунлик лимит. Фақат каталог/жорий нарх-қолдиқ; буюртма яратмайди, нарх/қолдиқ/пулни ўзгартирмайди. Тавсиф — фақат қоралама.

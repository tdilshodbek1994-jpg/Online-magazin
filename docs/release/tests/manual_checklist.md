# Қўлда қабул синовлари

Ҳамма пункт ҳали [ ]: ҳақиқий телефон, Telegram, провайдер ёки репозиторий синовлари бу пакетда ўтказилмаган. Қурилма/OS/app/browser версияси, commit ва сана қайд этилсин. Реал пул/хабар фақат owner рухсатли тестда.

## Android — 20 пункт
- [ ] A01. 320–430 px экранда каталог → checkout → тасдиқ → асосий тугмалар кесилмасин.
- [ ] A02. Клавиатура очиқда исм/манзил ёзинг → хатолар ва Сақлаш кўринсин.
- [ ] A03. Кирилл/лотин алмаштиринг → draft товар/миқдор/манзил сақлансин.
- [ ] A04. 200% матн ва dark режим → суммалар, статус ва тугмалар ўқилсин.
- [ ] A05. Паст интернетда form submitни такрор босинг → битта order.
- [ ] A06. Офлайн draft тузиб онлайнга қайтинг → янги quote ва тасдиқ талаб.
- [ ] A07. Referral ҳаволасидан order қилинг → тўғри partner/flow snapshot.
- [ ] A08. On-behalf формага киринг → товар/flow тайёр; мижоз алоҳида тасдиқлансин.
- [ ] A09. Яна буюртма босинг → аввалги мижоз телефони/манзили қолмасин.
- [ ] A10. Мижоз offer ҳаволасини очинг → ўз манзилини киритади, бегона PII йўқ.
- [ ] A11. Бегона order ID/forward ҳавола → махфий маълумот ва ўзгартириш ёпиқ.
- [ ] A12. Бир дона stockга икки қурилмадан buy → oversell йўқ.
- [ ] A13. Оператор callbackни очинг → аниқ order, вақт ва internal/public note ажралган.
- [ ] A14. Бир қисм delivery/return → аниқ товарлар ва ҳолатлар алоҳида.
- [ ] A15. Payout unknownни очинг → қайта ечишга йўл йўқ, сабаб кўринади.
- [ ] A16. UzCoin cashout ва gift бир вақтда → сарф балансдан ошмайди.
- [ ] A17. Маркетингдан чиқинг → order support ишлайди, реклама тўхтайди.
- [ ] A18. Logout ва бошқа аккаунт → аввалги draft/history/cache очилмасин.
- [ ] A19. AI ўчиқ → каталог, checkout, оператор навбати ишласин.
- [ ] A20. Инцидент traceни юборинг → махфий маълумотсиз diagnostic packet.

## iPhone — 20 пункт
- [ ] I01. Safari ва Telegram webviewда асосий харид → ўлчам/клавиатурага мос.
- [ ] I02. OTPни paste/autofill қилинг → тўсиқсиз, логларда код йўқ.
- [ ] I03. Appни фонга ўтказиб қайтинг → quote/ҳолат янгилансин, дубль submit йўқ.
- [ ] I04. 200% матн, landscape, dark → асосий тугмалар беркилмасин.
- [ ] I05. VoiceOver билан product/checkout → майдон номлари ва хатолар маъноли.
- [ ] I06. Кирилл/лотин → товар variant/draft сақлансин.
- [ ] I07. GPSни рад қилинг → қўлда манзил/харид ишласин.
- [ ] I08. Private order ҳаволасини бегона профилда очинг → permission сақлансин.
- [ ] I09. Мижозга тайёр offer юборинг → URLда контакт маълумоти бўлмасин.
- [ ] I10. Offer expired → эски суммадан автоматик order йўқ.
- [ ] I11. Қўшимча товар тавсиясини босмасдан checkout → саватга қўшилмаган.
- [ ] I12. Оператор смена handoff → callback/изоҳ/масъул йўқолмасин.
- [ ] I13. Фото return далили юклансин → файл private ва progress ҳақиқий.
- [ ] I14. Partial refund → пул/товар/комиссия ҳолатлари ажралсин.
- [ ] I15. Notification рухсат/канал йўқ → созланмаган ҳолат очиқ, сохта success йўқ.
- [ ] I16. Coin reserve pending → cash available билан аралашмасин.
- [ ] I17. Офлайн read/draft → stale/unsynced мақоми; payout автоматик queue эмас.
- [ ] I18. Аккаунт алмаштиринг → private cached export/history тозалансин.
- [ ] I19. AI/tool timeout → молиявий амал бажарилган деб кўрсатилмасин.
- [ ] I20. Support order картасини очинг → ички note customerга кўринмасин.

## Desktop ва операциялар
- [ ] D01. Клавиатура фокус/shortcut ва modal close → маълумот йўқолмасин.
- [ ] D02. Bulk actionда per-row conflict → partial натижа ҳақиқий.
- [ ] D03. Бир userдан role revoke → history/export ҳам қайта текширилади.
- [ ] D04. Import dry-run → нарх/қолдиқ тасдиқсиз ўзгармайди.
- [ ] D05. Реал PostgreSQL lock/rollback синови → SQLite билан алмаштирилмаган.
- [ ] D06. Payment sandbox timeout/replay/refund → evidence ва unknown ҳолати.
- [ ] D07. Назоратли live provider тест → аниқ owner approval, чекланган сумма ва reconciliation.
- [ ] D08. Restore staging → outbound workers off, ledger/stock текширилган.
- [ ] D09. Юридик/fiscal/retention gate → масъул тасдиқ, эски шаблон автоматик қабул эмас.
- [ ] D10. Release SHA ва CI SHA → бир хил.
- [ ] D11. Demo/synthetic records ва secrets → productionга ўтмаган.
- [ ] D12. Эга go-live preview → scope/features/budget аниқ; рухсатсиз deploy йўқ.

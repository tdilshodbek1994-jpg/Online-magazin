# Қарорлар, тахминлар ва манбалар

## Манба ва мақом
Ушбу пакет — янги кенгайтирилган топшириқ. Мавжуд репозиторийга кирилмаган; модулларнинг тайёрлиги текширилмаган.
Асос сифатида шу суҳбатдаги эга қоидалари ва UZSHOP_AI_BUSINESS_ASSISTANT_CLAUDE_TASK.txt ҳамда UZSHOP_LANDING_TARGET_PRO_CLAUDE_TASK.txtнинг роллар, ҳисоб-китоб, атрибуция ва ўзгариш чегараларига оид қисмлари кўриб чиқилди. Уларнинг ҳар бир банди кодда бажарилган деб ҳисобланмайди.
Янги UX ва операция ғоялари — ушбу пакетнинг таклифлари. Мавжуд тасдиқланган contractга зид келса decision log ёзилади, эски қоида яширин алмаштирилмайди.

## Сақланадиган қарорлар
- Эга маҳсулотни жойлайди; ҳамкор мустақил seller эмас.
- Ҳамкор referral ҳавола ҳам, мижоз розилиги билан on-behalf order ҳам ишлатади.
- 1/2/3 дона комиссия: 100%;100%+25%;100%+50%+25%. Фоиз товар нархига эмас, тегишли базавий комиссияга.
- 1 eligible unit = 1 UzCoin; бошланғич курс 3 000 UZS. Actual rate хизмат/snapshotдан.
- Ҳамкорнинг реклама сарфи киритилиши walletдан пул ечиш эмас.
- Хайрия фақат аниқ ихтиёрий consent; penalty ва donation аралашмайди.
- 30%дан паст сифат натижаси automatic fine эмас; далил, cohort ва appeal талаб.
- Customer business AIга кирмайди. Ҳар роль current server grantsга боғланган.
- TAQVIM ва UzShop мустақил; main/deploy/пулли амаллар тасдиқ билан.

## Productionдан олдин ҳал этиладиган очиқ қарорлар
| ID | Қарор | Таклиф / чегара | Ким тасдиқлайди |
|---|---|---|---|
| D01 | Қайси модуллар pilotда очиқ? | P0 критик; P1дан фақат тестлангани | Эга + tech lead |
| D02 | 4+ дона комиссия | Тасдиқсиз ставка йўқ; review ёки савдо қоидаси | Эга + молия |
| D03 | Refundдан кейин комиссия | Сақланган матрицада қолган eligible unit бўйича; existing policy устун | Эга + молия |
| D04 | Узоқдан payment/COD тасдиғи | Customer consent, delivery, collected/remitted мезонлари | Эга + молия |
| D05 | Қайта хариднинг attributionи | Эски partnerни абадий автоматик боғлаш йўқ; policy version | Эга |
| D06 | Шахсий offer TTL | Муддат config; ҳар submitда quote/auth; иш кунлари эмас аниқ timestamp | Эга + tech lead |
| D07 | Service deadlines ва shift | Реал иш соати/жамоа асосида; уйдирма 24/7 йўқ | Эга + operator lead |
| D08 | 30% назорат denominatorи | Натижаси етук, етарли ҳажмли cohort; related cause | Эга + quality |
| D09 | UzCoin cashout/charity/penalty | Ҳуқуқий, ҳисобчилик ва провайдер асоси бўлмаса live off | Эга + мутахассис |
| D10 | Хайрия қайтариши | Earmarked/ўтказилган ҳолатлар алоҳида; автоматик берганни қайтариш йўқ | Эга + молия |
| D11 | Backup RPO/RTO | Аввал инфра/бюджет ва restore ўлчови; рақамни қоғозда кафолатлама | Эга + tech lead |
| D12 | PII retention/hosting | Маълумот тури, қонуний мақсад, backup ва processorлар | Эга + ҳуқуқий мутахассис |
| D13 | Pilot peak load | Реал мақсадни белгила; 100 session/10 checkout — фақат синов мисоли | Эга + tech lead |
| D14 | Provider readiness | Реал merchant/API ҳуқуқи, sandbox ва назоратли тест | Эга + интегратор |
| D15 | Молиявий тасдиқлар | Step-up, лимит ва зарур икки шахс; чат «ҳа» умумий рухсат эмас | Эга + молия |
| D16 | Fiscal receipt | Ташкилот ва тўлов моделига мос амалдаги талаб, провайдер шартномаси | Эга + ҳисобчи |

## Қўшимча таклифлар ва scope
Қулайликлар: product контекстидан on-behalf, customer completion offer, earnings explanation, order self-service, unified work queue, replenishment drafts, owner exception inbox.
P2га қолади: native mobile apps, кўп мустақил seller marketplace, advanced forecast, мураккаб multiwarehouse routing, халқаро солиқ тизими ва чексиз automation builder.
Бу кечиктириш келажакда қилмаймиз дегани эмас; биринчи савдо ядросини релиз қилиш чегараси.

## Манбалар — 2026-11-05да кўриб чиқилди
Манбалар техник/ҳуқуқий текширув учун; улар UzShop кодини текширганимизни билдирмайди.
[S1] OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
Ҳар сўровда authorization ва minimal privileges талабларига асос.
[S2] W3C Accessible Authentication: https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html
Password manager, copy-paste ва когнитив тўсиқларни камайтириш йўналиши.
[S3] W3C Redundant Entry: https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html
Бир жараёнда аввал киритилган маълумотни қайта киритишга мажбурламаслик; хавфсизлик ва яроқсизлик истиснолари.
[S4] OWASP Transaction Authorization: https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
Молиявий/муҳим амалнинг аниқ маълумотини serverда тасдиқлаш.
[S5] Google web.dev Web Vitals: https://web.dev/articles/vitals
LCP, INP, CLS ва field/lab ўлчовларини ажратиш.
[S6] PostgreSQL 17 Continuous Archiving/PITR: https://www.postgresql.org/docs/17/continuous-archiving.html
Base backup ва WAL recovery; ҳақиқий PostgreSQL версиясига мос ҳужжатни implementationда танла.
[S7] PostgreSQL 17 Backup and Restore: https://www.postgresql.org/docs/17/backup.html
Backup турлари ва тиклашни режалаштириш.
[S8] LexUZ Электрон тижорат тўғрисида, ЎРҚ-792: https://lex.uz/docs/6213382
Оферта/сотувчи/етказиш/қайтариш/ҳисоб-китоб release reviewи учун. Кучга кириш санаси ва амалдаги таҳрир релиз куни қайта текширилсин.
[S9] LexUZ Шахсга доир маълумотлар тўғрисида, ЎРҚ-547: https://lex.uz/docs/4396419
Маълумот йиғиш, розилик, сақлаш, узатиш ва йўқ қилиш сиёсати reviewи учун. Бу файл қатъий ҳуқуқий хулоса эмас.
[S10] OWASP File Upload: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
Файл тури, ҳажм, ном, мазмун, сақлаш ва кириш текширувлари.
[S11] PostgreSQL 17 Numeric Types: https://www.postgresql.org/docs/17/datatype-numeric.html
Аниқ пул арифметикаси учун numeric/integer; float билан аралаштирмаслик.

Янги Meta/SMS/Telegram/delivery ҳуқуқлари ва тўлов API версиялари бу пакетда жорий аккаунтда текширилмаган. Улар adapter-specific contract/test билан тасдиқланади. Мавжуд ишлайдиган версияни тахмин билан алмаштирма.

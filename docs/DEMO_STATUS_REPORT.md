# DEMO holati — modullar bo'yicha (2026-11-02)

Belgilar: ✅ tayyor va testlangan · 🟡 ishlaydi, lekin cheklov bor · ⛔ tashqi kalit/shartnoma kerak · ⏸ ataylab keyinga qoldirilgan.
Dalil: API testlari 81/81 (real PostgreSQL), brauzer E2E 13/13 — aynan DEMO topologiyasida (Caddy + parol + 2 GB limitlar), GitHub CI.

| Modul | Holat | Izoh |
|---|---|---|
| Katalog, variantlar, qidiruv (lotin/kirill), mahsulot sahifasi, SEO | ✅ | E2E-1, E2E-2, axe |
| Savat, server quote, buyurtma (mehmon/tasdiqlangan), idempotentlik | ✅ | E2E-3/4/12, T019–T027 |
| OTP kirish, sessiyalar, MFA (TOTP) + step-up | 🟡 | Ishlaydi; SMS provayder yo'q — DEMO'da kod ekranda ko'rinadi (shuning uchun sayt parol ortida) |
| Operator CRM (navbatlar, claim, qo'ng'iroq natijasi) | ✅ | E2E-9, T045–T049 |
| Ombor: rezerv, yig'ish, jo'natish, qaytgan tovar karantini | ✅ | T051–T060 |
| Kuryer, COD topshirish, moliya solishtiruvi | ✅ | B-E2E, T057–T058 |
| Hamkor: havola, mijoz nomidan buyurtma (mijoz OTP tasdig'i), komissiya ledger | ✅ | T031–T047, T098–T099 |
| Payout (maker≠checker, bank referensi bilan) | ✅ | T078–T080; bank o'tkazmasi qo'lda |
| Qaytarish, refund (qatorlar bo'yicha) | ✅ | T068–T070, T099 |
| Buyurtmani o'zgartirish (mijoz qayta tasdig'i) | ✅ | T050 |
| CSV import, rasm yuklash | ✅ | T029, T030 |
| Promo-kodlar | ✅ | T026–T028 |
| Egasi hisobotlari, CSV eksport | ✅ | T081–T084 |
| Support tiketlari, xodim taklifi | ✅ | testlangan |
| Marketing kampaniyalari (rozilik suppression) | 🟡 | Logika testlangan; real SMS yuborilmaydi (provayder yo'q) |
| **AI yordamchi** | ✅ / ⛔ | Lokal katalog provayderi + UI + admin kill switch — testlangan (E2E-13). Tashqi Claude API: kod va kontrakt testlari tayyor, **haqiqiy kalit bilan sinalmagan** (`ANTHROPIC_API_KEY` kerak) |
| Payme / Click | ⛔ | Protokol adapterlari va kontrakt testlari tayyor; merchant shartnoma + kalit kerak. DEMO'da MOCK to'lov |
| SMS provayder | ⛔ | Adapter joyi tayyor; provayder tanlanishi kerak |
| Telegram | 🟡/⛔ | Bog'lash logikasi testlangan; Online Magazin boti tokeni kerak |
| Fiskal chek | ⛔ | Provayder + moliyachi qarori kerak |
| Huquqiy matnlar | ⛔ | Qoralama, huquqshunos ko'rishi kerak |
| Biznes qiymatlari (komissiya, hold, payout min, yetkazish narxi) | 🟡 | DEMO fixture; production'da egasi tasdiqlashi shart |
| Docker / 2 GB DEMO compose | ✅ | Lokal o'lchov: 4 konteyner ~150–260 MB RAM; image'lar ~1.6 GB |
| Serverga joylash | ⏸ | Siz tasdiqlaguncha hech narsa qilinmagan; ulanish variantlari: `docs/SERVER_ACCESS_OPTIONS.md` |

## Lokal DEMO'ni ishga tushirish
```bash
scripts/demo-local.sh --build      # https://localhost, brauzer paroli terminalda ko'rsatiladi
scripts/demo-local.sh --down       # to'xtatish
```

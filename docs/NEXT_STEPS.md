# NEXT STEPS

Кодда бажариладиган Phase 1 иши тугалланди. Қолганлари ташқи қарор/калит ёки production муҳитини талаб қилади:

1. **Owner қарорлари (Appendix B)** — `/admin` → policies: комиссия қоидалари (ҳар маҳсулот), attribution муддати, hold, payout минимал ва тасдиқ режими, етказиш ҳудудлари/тарифлари. Demo қийматлар production'да ишламайди.
2. **Payme:** merchant кабинетида test kassa → `PAYME_MERCHANT_ID`, `PAYME_KEY`, `PAYME_MODE=sandbox` → Payme test suite → live. Click: `CLICK_SERVICE_ID`, `CLICK_SECRET_KEY`.
3. **SMS провайдер** (OTP ва мижоз тасдиғи учун) — адаптерни `apps/api/src/worker.ts` dev adapter ўрнига улаш.
4. **Telegram:** алоҳида Online Magazin боти → `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, webhook URL.
5. **Фискал провайдер** ва **ҳуқуқий матнлар** (оферта, қайтариш, privacy, ҳамкор шартномаси) — мутахассис текшируви.
6. **Production муҳит:** домен/TLS, `MFA_ENC_KEY`, `OM_DB_PASSWORD`, backup жадвали ва offsite нусха, production ҳажмида RPO/RTO ўлчови.
7. Ихтиёрий: ташқи LLM провайдери (калит, бюджет, маълумот сиёсати тасдиғидан кейин), қўлда screen-reader текшируви, ҳақиқий мобил қурилмада синов.

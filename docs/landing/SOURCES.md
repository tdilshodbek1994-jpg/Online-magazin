# Техник манбалар ва текширув чегаралари

Тадқиқот санаси: 2026-11-04. Пастдаги манбалар — расмий ҳужжатлар ёки Meta’нинг ўз SDKси. Улар UzShop аккаунтида permission борлиги ёки интеграция ишлаганини исботламайди. Ҳеч қайси манбадан узун парча ёки код кўчирилмади.

## Очилган бирламчи манбалар

S1. Meta — Facebook Business SDK for Python, README. Business/Marketing API, app ва access token билан ишлаш асоси. READMEдаги айрим legacy permission номларини кўр-кўрона кўчирмаслик; ишлаб чиқишда current API versionни текшириш.
https://github.com/facebook/facebook-python-business-sdk

S2. Meta SDK — serverside/Event. event_name, event_time, event_source_url, event_id, user_data, action_source майдонлари.
https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/serverside/event.py

S3. Meta SDK — serverside/ActionSource. website, phone_call, chat каби ҳақиқий воқеа манбаларини ажратиш.
https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/serverside/action_source.py

S4. Meta SDK — Campaign. status, configured_status, effective_status, daily_budget, lifetime_budget, spend_cap ва PAUSED каби API майдонлари. Майдон борлиги муайян аккаунтда ҳар сценарий қўлланишини кафолатламайди.
https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/campaign.py

S5. Meta’нинг архивланган Server-Side API схемаси. event_id ва event_name орқали browser/server воқеаларини ажратиш/дедупликация тамойили. РЕПОЗИТОРИЙ 2022 ЙИЛДА АРХИВЛАНГАН: бу жорий API version, қабул оралиғи ёки quota учун манба эмас; current integration ҳужжати ва real test билан қайта текшириш шарт.
https://github.com/facebookarchive/Facebook-Server-Side-API-Swagger/blob/main/server-side-api.yaml

S6. Meta SDK — AdsInsights. spend, account_currency, date_start/date_stop, ad/adset/campaign, publisher_platform ва attribution settings. Allowed breakdown combinations implementationда текширилади.
https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/adsinsights.py

S7. OWASP — Unvalidated Redirects and Forwards Prevention. Trafficback/destination учун allowlist ва сервер назоратига асос.
https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html

S8. OWASP — Server Side Request Forgery Prevention. URL import, external fetch, private network ва redirect назорати.
https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

S9. Google web.dev — Web Vitals. LCP 2.5s, INP 200ms, CLS 0.1 ва 75-percentile ўлчов мақсадлари; field/lab натижаларини ажратиш.
https://web.dev/articles/vitals

S10. Google Search Central — Website A/B testing. Cloakingдан сақланиш, canonical ва вақтинчалик redirect, синовни узоққа чўзмаслик.
https://developers.google.com/search/docs/crawling-indexing/website-testing

S11. W3C — WCAG 2.2. Accessibility талаблари. Ҳужжатдаги 44×44 CSS px — UzShop учун лойиҳа талаби; WCAG AA минимал target-size қоидаси билан тенглаштирилмайди.
https://www.w3.org/TR/WCAG22/

S12. Let’s Encrypt — Challenge Types. TLS сертификати учун domain control proof ва HTTP-01/DNS-01; бу Meta domain verificationдан алоҳида.
https://letsencrypt.org/docs/challenge-types/

S13. Meta — Official Facebook Marketing API Postman workspace. Расмий API сценарийлари учун кириш нуқтаси; workspace очилди, ҳар бир collection request бу муҳитда текширилмади.
https://www.postman.com/meta/facebook-marketing-api/overview

S14. Meta SDK — serverside/UserData. Matching identifiers, client_ip_address, client_user_agent, fbp/fbc ва бошқа fields. Мавжуд майдонларнинг ҳаммасини тўплаш талаб қилинмайди; minimal permitted payload.
https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/serverside/user_data.py

## Бу муҳитда тўлиқ очилмаган саҳифалар

Meta developers саҳифалари 429/access error, Business Help/Business Tools Terms эса login/access чеклови берди. Уларни «тўлиқ текширилган жорий қоида» деб ҳисобот қилмаймиз. Implementationда current domain verification, ads_read/ads_management/бошқа зарур scopes, review/access requirements, budget semantics, CAPI event freshness/dedup ва data-processing conditions қуйидаги расмий йўналишлардан қайта текширилсин:
https://developers.facebook.com/docs/marketing-api/get-started/
https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events/
https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event/
https://developers.facebook.com/docs/sharing/domain-verification/verifying-your-domain/
https://www.facebook.com/legal/technology_terms

API версияси, текширув санаси, runtime feature support ва account-specific блокерлар репозиторийдаги capability/release gate ҳисоботига ёзилади. Очилмаган манба ўрнига блог даъвосини расмий қоида деб олмаймиз.

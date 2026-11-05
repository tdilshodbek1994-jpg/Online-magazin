# Telegram Mini App — partner cabinet (bot «Uzshop_admin»)

Branch `claude/online-marketplace-platform-sdtv52`. Not merged or deployed by Claude.

## What it is

The same `/partner` cabinet (orders, wallet, products, AI, stats …) opens inside Telegram from the partner bot.
There is no second copy of the cabinet: one code base, so every fix on the site is also in the bot.

| Bot | App | Status |
|---|---|---|
| Uzshop_admin | partner cabinet `/tg/partner` → `/partner` | **done (this step)** |
| Uzshop_operator | operator room `/tg/operator` → `/ops` | **done** — only staff with `orders.read_all` (operator/owner) can link or log in; removed staff lose access at the next open |
| Uzshop_push | notifications | later (today notifications use `TELEGRAM_BOT_TOKEN`) |

## How login works (security)

1. Telegram gives the page signed `initData`. The API checks the signature with the partner bot token (HMAC-SHA256,
   key = HMAC("WebAppData", token)), refuses data older than `TG_WEBAPP_MAX_AGE_SECONDS` (default 1 day) and data with a future date.
2. Telegram only proves «Telegram user N». A cabinet opens only when N is **linked** to a UzShop account.
3. A link is created only by someone who already proved the account:
   - inside the mini app: phone + SMS code (normal login), then «Tasdiqlash va ulash», or «… sifatida davom etish» when already logged in on the device;
   - or on the website: Hamkor kabineti → Bildirishnomalar → «Telegram ilovada ochish» (one-time link, 10 minutes, `t.me/<bot>?startapp=l_…`).
4. One Telegram ↔ one account per bot. A Telegram tied to account A cannot be taken by account B (409).
5. «Chiqish» inside the mini app unties this Telegram and ends the session; the next open asks to link again.
6. Session is a normal UzShop session (bound to the phone, revocable in «Sessiyalar», `user_agent = telegram-partner-app …`). Audit: `telegram_app.linked`, `user.login` with `method=telegram_partner_app`.

## Inside Telegram

`telegram-web-app.js` loads only when the page is opened from the bot (nothing changes on the normal site).
`ready()`, `expand()`, swipe-to-close off while scrolling, header and background colours match the cabinet,
Telegram's Back button works on every inner page, outside links open through Telegram (`openLink` / `openTelegramLink`),
the site footer and «install app» bar are hidden. `startapp` parameters: `orders`, `wallet`, `ai`, `new`, `market`,
`notifications`, `stats`, `payouts`, `o_<order id>` (opens that order) — for links in future bot messages.

## Operator bot

Same login rules as the partner bot, plus the role rule above. One person can link the same Telegram to both bots
(two separate links). Website: Operator xonasi → bottom card «Telegram ilovada ochish». `startapp`: `board`, `ai`,
`templates`, `o_<order id>` (opens that order card). Setup: `bash scripts/server/telegram-app-setup.sh operator`
with the Uzshop_operator token. Tests: 4 more in `zr-tgapp` (15 total).

## Owner steps (server, as user `om`)

1. Deploy as usual: `cd ~/online-magazin && bash scripts/server/deploy-from-git.sh` (migration 0047).
2. Connect the bot: `bash scripts/server/telegram-app-setup.sh partner`, then paste the Uzshop_admin token from BotFather (it is hidden on screen, never send it in chat).
   The script saves `TELEGRAM_PARTNER_BOT_TOKEN/_USERNAME/_WEBHOOK_SECRET` in `.env`, restarts the API, sets the webhook
   (`/api/v1/webhooks/telegram/app/partner`), the menu button «Kabinet» → `https://<domain>/tg/partner`, short description and `/start`.
3. Optional in BotFather: Bot Settings → Configure Mini App → URL `https://<domain>/tg/partner` (enables `t.me/<bot>?startapp=` links and the «Open» button in the bot profile).
4. Check: Admin → Integratsiyalar holati shows «Telegram hamkor ilovasi».

## Two server settings that need the owner's decision (NOT changed by Claude)

| Setting | Why it matters | Option |
|---|---|---|
| DEMO site password (`Caddyfile.staging`, HTTP basic auth on the whole site) | Telegram's in-app browser cannot show the password window, so the mini app cannot open while the whole site is behind the password | (a) open the site without the password (production `Caddyfile`), or (b) let only the mini app through. Code for (b) is ready but off: the API sets a signed `om_stage` cookie after a verified **and linked** Telegram login (only when `OM_STAGE_GATE_SECRET`, at least 32 characters, is set) and `GET /api/v1/stage-gate` checks it. Caddy would need a `forward_auth` rule for that cookie. Note: with (b), the dev OTP shown on screen stays behind the password, so the first link must be made from the website («Telegram ilovada ochish») |
| `X-Frame-Options: DENY` in the production `Caddyfile` | The mobile Telegram apps work. Telegram **Web** (web.telegram.org in a desktop browser) shows mini apps inside a frame and will be blocked | Replace it with `Content-Security-Policy: frame-ancestors 'self' https://web.telegram.org`, if you want the cabinet in Telegram Web too |

## Tests

`apps/api/test/zr-tgapp.test.ts` (own DB `om_test_tgapp`, fake bot token, no network), 11 tests: valid initData, tampered data,
another bot's signature, expired and future dates, malformed data, unlinked user gets no session or cookie, operator bot
not configured → 503, identity fields rejected, link inside the app then direct login (same account, phone-bound session,
audit), a Telegram tied to A cannot be taken by B, one-time link token (works once, reuse and expiry refused), unlink,
locked account, staging-gate cookie, webhook secret.

UI checked locally with Playwright and a simulated `Telegram.WebApp`: entry screen → phone code → linked → `startapp=wallet`
opened the wallet; Back button shown on inner pages; a second open went straight into the cabinet; outside Telegram the entry page says to open it from the bot.

# DEMO → haqiqiy sayt (go-live)

Owner decisions (2026-11-05): login codes by **Eskiz.uz SMS**; the real shop starts on a **new empty database**
(the DEMO database is kept and backed up, not deleted); payments **cash on delivery only** (Payme/Click off until contracts).

## Why SMS is required first

In production mode the login code is no longer shown on screen. Without SMS nobody (the owner included) can log in.

## What you need from Eskiz (owner)

1. An account at eskiz.uz, a contract and a balance.
2. **An approved SMS text.** Eskiz sends only texts that passed moderation. Suggested text:
   `UzShop: tasdiqlash kodi 123456. Kodni hech kimga bermang.` (in the script you write it with `{code}` instead of the digits).
3. Optional: your own sender name (until it is approved, Eskiz's test sender `4546` is used).

## Steps on the server (as user `om`, in `~/online-magazin`)

```
bash scripts/server/deploy-from-git.sh
bash scripts/server/sms-setup.sh
bash scripts/server/go-live.sh
```

- `sms-setup.sh` asks for the Eskiz email and password (password hidden), checks them with Eskiz, then asks for the sender name and the approved text, and can send one test SMS to your phone. Never paste the password into chat.
- `go-live.sh` asks for your phone number and the word `HA`, then:
  1. makes a full backup `~/backups/demo-final-*.dump`;
  2. creates the empty database `uzshop_live`;
  3. switches the site to production: no demo password, codes only by SMS, online payments off;
  4. creates reference data and **one owner account** for your phone.
- Rollback to the DEMO at any time: `bash scripts/server/go-live.sh --rollback` (both databases stay).

## Right after the switch (owner)

| Step | Where |
|---|---|
| Log in with your phone + SMS code | site → Kirish |
| Turn on the authenticator (MFA) — needed for money actions | `/account/security` |
| Delivery price and zones (the starting tariff is a placeholder «DEMO tarif») | Admin panel (delivery zones) |
| Add real products (by hand or CSV import) | Admin panel → products / import |
| Invite staff (operator, warehouse, courier) by phone | Admin panel → staff |
| Partners register again on the real site; link the Telegram mini app again | Hamkor kabineti → Bildirishnomalar → «Telegram ilovada ochish» |
| Business values still marked as demo: hold days (14), payout minimum, attribution window | owner decision; values in `business_policies` (is_demo) |
| Legal texts are still DRAFT — a lawyer must approve them before real sales | lawyer → legal document versions |
| Health page: SMS (Eskiz), Telegram, worker | Admin panel → integrations health |

## Still not connected (honest)

Payme / Click (contract and keys), fiscal receipts, lawyer-approved texts, real-device checklist, restore drill on a copy.

## Code

- `apps/api/src/modules/notifications/sms.ts`: Eskiz adapter (login, token cache, re-login on 401, 4xx = permanent).
- Worker: an OTP SMS is sent with the code decrypted at send time. The code is stored only encrypted (AES-GCM, `MFA_ENC_KEY`) and wiped from the row after the attempt. Codes older than 10 minutes are never sent.
- `apps/api/src/live-init.ts`: schema, reference data and owner on an empty database. It refuses a database that already has orders.
- `docker-compose.yml`: database name from `OM_DB_NAME` (default `online_magazin` = DEMO).
- `/features` returns `demo`. The footer «DEMO versiya» note is shown only in DEMO.
- Tests: `apps/api/test/zs-sms.test.ts` (5, fake Eskiz, no network): sends approved text, wipes the code, re-login on expired token, 4xx → failed without retries, 5xx → retry, not configured → nothing sent, stale code never sent.

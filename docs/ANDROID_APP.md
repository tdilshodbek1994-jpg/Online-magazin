# UzShop Android app

Owner decisions (2026-11-05): ONE app «UzShop» for everyone, roles decide what opens; Android first; built on the
website (Capacitor), so every website fix is in the app too.

## What opens for whom

The app starts at `https://uzshop.net/app`:

| Person | Opens |
|---|---|
| not logged in / customer | shop (`/`) — browse, cart, orders; «Kirish» goes back to `/app` after login |
| partner | partner cabinet `/partner` |
| operator | operator room `/ops` |
| owner / finance / catalog (Boshqaruv) | `/admin` |
| courier | `/courier` |
| several roles | a chooser (Boshqaruv / Operator / Hamkor / Kuryer / Do‘kon); the choice is remembered; «🔀 Bo‘limlar» in the menu changes it |

Inside the app: hardware Back button goes back (on a start screen it closes the app), footer and «install app» bar are
hidden, camera permission for barcode scanning and photos (asked only when used), offline screen with «Qayta urinish»,
brand icon and green splash screen. Outside links (Telegram, Instagram, maps, phone calls) open in their own apps.

## Files

- `mobile/` — Capacitor project (outside the pnpm workspace on purpose; the server build is not affected).
  `capacitor.config.json` (app id `net.uzshop.app`, start URL, user agent `UzShopApp/1.0`), `www/offline.html`, `android/`.
- Web: `app/app/page.tsx` (start screen), `lib/native.ts`, `components/AppBridge.tsx`, «Bo‘limlar» link in the header.
- CI: `.github/workflows/android.yml` — builds a **debug APK** on every push that touches `mobile/` (download it from the
  workflow run → Artifacts → `uzshop-debug-apk`, install on a phone). A **signed AAB** for Google Play is built only when
  the signing secrets exist.

## Before Google Play (owner)

1. Google Play Console account (one-time 25$).
2. Create the upload key ONCE on your own computer or the server (keep the file and passwords safe — losing them means you cannot update the app):
   `keytool -genkey -v -keystore uzshop.jks -alias uzshop -keyalg RSA -keysize 2048 -validity 10000`
3. GitHub → repository Settings → Secrets → Actions: `UZSHOP_KEYSTORE_BASE64` (output of `base64 -w0 uzshop.jks`),
   `UZSHOP_KEYSTORE_PASSWORD`, `UZSHOP_KEY_ALIAS` (= uzshop), `UZSHOP_KEY_PASSWORD`. Never paste them into chat.
4. Play Console needs: privacy policy URL (lawyer-approved text), screenshots, short/long description, content rating.

## Important

- The app opens the live site. While the site is behind the DEMO password the app cannot open it (Android, like Telegram,
  does not show the password window). It works after the switch to the real site (`docs/GO_LIVE.md`).
- Push notifications: see below.
- iPhone: later (Apple Developer 99$/year + a Mac or a paid cloud build).

## Push notifications (done in code; needs Firebase from the owner)

The same events as the partner Telegram messages (new order, delivered, money available, payout, bonus, level…) also go
as a push to the person's phones; a tap opens that order/page. Marketing is never pushed. Logout stops pushes to that phone.
A phone logged in by someone else moves to that person. Dead tokens are removed automatically; a retry never pushes twice.

Owner steps (Firebase is free):
1. console.firebase.google.com → new project «UzShop» → add an **Android app** with package name `net.uzshop.app`.
2. Download `google-services.json` → GitHub → Settings → Secrets → Actions → new secret `GOOGLE_SERVICES_JSON` with the
   file's whole text. The next app build includes push (the build log says «Firebase: on»).
3. Firebase → Project settings → Service accounts → «Generate new private key» (a JSON file). Put it on the server and run
   `bash scripts/server/push-setup.sh /path/to/file.json` (the script deletes the file after saving). Never send it in chat.
4. Admin → integrations health shows «Ilova push bildirishnomalari».

Builds made without Firebase never ask for push permission (the website checks the app's user agent), so they cannot crash.
Tests: `apps/api/test/zt-push.test.ts` (5, fake Google): deep link, dead token revoked, 503 retry without duplicates,
logout and device moving to a new user, login required / bad token / marketing not pushed.

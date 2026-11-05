# Final release — handoff

- Repo/branch: `tdilshodbek1994-jpg/Online-magazin` · `claude/online-marketplace-platform-sdtv52` (not merged to main; deploy by the owner)
- Migrations added in this package: 0041 self-service · 0042 finance day close · 0043 pick scans · 0044 replenishment · 0045 reviews · 0046 automation (forward-only, applied by the deploy script)
- Status matrix: `docs/release/STATUS.md` · gates: `docs/release/RELEASE_GATES.md` · status vocabulary: `docs/release/STATUS_DICTIONARY.md`

## Commands (local, PostgreSQL 16)
- `npx tsc --noEmit` (api, web) — exit 0
- `npx vitest run` — 42 files, 357 tests passed
- `npm run build` (web) — compiled; phone-width checks of new screens

CI was not run by Claude for these commits; local results are not CI.

## What only the owner can close
Payment provider contract + sandbox + limited live test · SMS provider · fiscal provider · lawyer-approved legal texts and retention · restore drill on a copy of the real server · real-device checklist (`docs/release/tests/manual_checklist.md`) · business decisions: commission hold days (14 = demo), 4+ unit commission, delivery slots/tariffs.

## Next exact task
Run the manual device checklist on Android/iPhone against the staging/demo server and record results in `docs/release/tests/manual_checklist.md`.

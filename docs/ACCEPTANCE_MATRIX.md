# Қабул матрицаси T001–T100

Ҳолатлар: `tested` (автоматик тест ўтди) · `partial` (қисман тест) · `implemented` (код бор, мос тест йўқ) · `manual` (ҳужжатланган қўл текшируви) · `externally_blocked` · `deferred` · `not_started`.

Жами: deferred: 2, externally_blocked: 1, implemented: 2, manual: 3, not_started: 5, partial: 8, tested: 79

| ID | Ҳолат | Далил (файл › тест номи) |
|---|---|---|
| T001 | manual | docker-compose.yml (project `online-magazin`, network `om_net`, volume `om_pgdata`, user `om_app`); grep TAQVIM in code → only an isolation comment |
| T002 | manual | checkpoint commit 99318e1 + local branch checkpoint/pre-phase1; `.env` git-ignored; secret grep clean |
| T003 | tested | apps/api/test/c-partner.test.ts › T003 |
| T004 | tested | apps/api/test/c-partner.test.ts › T004 |
| T005 | tested | apps/api/test/d-integrity.test.ts › T005 |
| T006 | tested | apps/api/test/d-integrity.test.ts › T006 |
| T007 | tested | apps/api/test/d-integrity.test.ts › T007 |
| T008 | tested | apps/api/test/c-partner.test.ts › T035/T008 |
| T009 | tested | apps/api/test/d-integrity.test.ts › T009/T010…; apps/web/e2e/smoke.mjs › E2E-8 |
| T010 | tested | apps/api/test/d-integrity.test.ts › T009/T010 (revoked session, role downgrade, phone-bound session); apps/api/test/c-partner.test.ts › T099 (one-time link replay) |
| T011 | tested | apps/api/test/d-integrity.test.ts › T011 |
| T012 | tested | apps/api/test/d-integrity.test.ts › T012/T097 |
| T013 | tested | apps/api/test/d-integrity.test.ts › T013/T014 |
| T014 | tested | apps/api/test/d-integrity.test.ts › T013/T014 |
| T015 | tested | apps/web/e2e/smoke.mjs › E2E-3 |
| T016 | partial | apps/web/e2e/smoke.mjs › E2E-5 (320px reflow on 4 pages). Open on-screen keyboard not emulated |
| T017 | partial | apps/web/e2e/smoke.mjs › E2E-6 (keyboard reachability + visible focus). Screen-reader run not done |
| T018 | tested | apps/web/e2e/smoke.mjs › E2E-3 |
| T019 | partial | apps/api/test/d-integrity.test.ts › T019/AC-M11-2 (idempotent confirm ×3); apps/web/e2e/smoke.mjs › E2E-4 (double click → 1 order). Offline UI state not emulated |
| T020 | not_started | MFA / step-up re-auth for owner & finance not implemented (`sessions.elevated_until` column only) |
| T021 | tested | apps/api/test/d-integrity.test.ts › T021; apps/web/e2e/smoke.mjs › E2E-2 |
| T022 | tested | apps/api/test/d-integrity.test.ts › T022/AC-X07 |
| T023 | tested | apps/api/test/d-integrity.test.ts › T023/AC-M02-1 |
| T024 | tested | apps/api/test/d-integrity.test.ts › T024/T025 |
| T025 | tested | apps/api/test/d-integrity.test.ts › T024/T025 |
| T026 | tested | apps/api/test/d-integrity.test.ts › T026/T027/T028 |
| T027 | tested | apps/api/test/d-integrity.test.ts › T026/T027/T028 |
| T028 | partial | apps/api/test/d-integrity.test.ts › T026/T027/T028 (expiry boundary; comparisons are timestamptz so TZ-independent) |
| T029 | not_started | CSV import with preview not implemented |
| T030 | not_started | Media upload endpoint not implemented |
| T031 | tested | apps/api/test/c-partner.test.ts › T098 |
| T032 | tested | apps/api/test/c-partner.test.ts › T032/T033 |
| T033 | tested | apps/api/test/c-partner.test.ts › T032/T033 |
| T034 | tested | apps/api/test/c-partner.test.ts › T034/AC-M29-1 |
| T035 | tested | apps/api/test/c-partner.test.ts › T035/T008 |
| T036 | tested | apps/api/test/c-partner.test.ts › T036 |
| T037 | tested | apps/api/test/c-partner.test.ts › T037 |
| T038 | tested | apps/api/test/c-partner.test.ts › T038 |
| T039 | tested | apps/api/test/c-partner.test.ts › T039 |
| T040 | tested | apps/api/test/c-partner.test.ts › T040 |
| T041 | tested | apps/api/test/c-partner.test.ts › T099 |
| T042 | tested | apps/api/test/c-partner.test.ts › T099 |
| T043 | tested | apps/api/test/c-partner.test.ts › T099 |
| T044 | tested | apps/api/test/c-partner.test.ts › T044 |
| T045 | tested | apps/api/test/c-partner.test.ts › T045 |
| T046 | tested | apps/api/test/c-partner.test.ts › T046/T047 |
| T047 | tested | apps/api/test/c-partner.test.ts › T046/T047 |
| T048 | tested | apps/api/test/d-integrity.test.ts › T049/T048 |
| T049 | tested | apps/api/test/d-integrity.test.ts › T049/T048 |
| T050 | implemented | No endpoint changes content/total after confirmation (only address with revision); dedicated negative test pending |
| T051 | tested | apps/api/test/d-integrity.test.ts › T051/AC-M22-1 (20 parallel, stock 1) |
| T052 | tested | apps/api/test/d-integrity.test.ts › T052 |
| T053 | tested | apps/api/test/d-integrity.test.ts › T053/T054 |
| T054 | tested | apps/api/test/d-integrity.test.ts › T053/T054 |
| T055 | tested | apps/api/test/d-integrity.test.ts › T055 |
| T056 | tested | apps/api/test/c-partner.test.ts › T099 (no reservation before confirmation) |
| T057 | tested | apps/api/test/d-integrity.test.ts › T057/T058 |
| T058 | tested | apps/api/test/d-integrity.test.ts › T057/T058 |
| T059 | tested | apps/api/test/c-partner.test.ts › T099 (quarantine before inspection) |
| T060 | tested | apps/api/test/d-integrity.test.ts › T060 |
| T061 | tested | apps/api/test/d-integrity.test.ts › T061 |
| T062 | tested | apps/api/test/d-integrity.test.ts › T062/T066; Click bad signature in T067 |
| T063 | tested | apps/api/test/d-integrity.test.ts › T063/T064 |
| T064 | tested | apps/api/test/d-integrity.test.ts › T063/T064 |
| T065 | tested | apps/api/test/d-integrity.test.ts › T065 |
| T066 | tested | apps/api/test/d-integrity.test.ts › T062/T066 |
| T067 | tested | apps/api/test/d-integrity.test.ts › T067/AC-M14-2 |
| T068 | tested | apps/api/test/d-integrity.test.ts › T068/T069 |
| T069 | tested | apps/api/test/d-integrity.test.ts › T068/T069 |
| T070 | tested | apps/api/test/d-integrity.test.ts › T070 |
| T071 | tested | apps/api/test/c-partner.test.ts › T098 |
| T072 | tested | apps/api/test/c-partner.test.ts › T098 (hold not elapsed → stays pending) |
| T073 | tested | apps/api/test/c-partner.test.ts › T073 |
| T074 | tested | apps/api/test/c-partner.test.ts › T074, T074-e2e |
| T075 | tested | apps/api/test/c-partner.test.ts › T075 |
| T076 | tested | apps/api/test/c-partner.test.ts › T076 |
| T077 | tested | apps/api/test/c-partner.test.ts › T099 (return then refund → single reduction) |
| T078 | tested | apps/api/test/c-partner.test.ts › T078/AC-M31-1 |
| T079 | tested | apps/api/test/c-partner.test.ts › T079 |
| T080 | tested | apps/api/test/c-partner.test.ts › T080 |
| T081 | tested | apps/api/test/d-integrity.test.ts › T081/T082 |
| T082 | tested | apps/api/test/d-integrity.test.ts › T081/T082 |
| T083 | tested | apps/api/test/d-integrity.test.ts › T084/T083 |
| T084 | tested | apps/api/test/d-integrity.test.ts › T084/T083 |
| T085 | tested | apps/api/test/d-integrity.test.ts › T085/T092 |
| T086 | externally_blocked | Telegram linking not implemented; needs a separate Online Magazin bot token (tables prepared) |
| T087 | not_started | Consent history API exists; marketing campaign sending/suppression not implemented |
| T088 | deferred | AI assistant (stage F) not started; feature flag off |
| T089 | deferred | AI not started |
| T090 | partial | No AI dependency exists in search/checkout/CRM, so they work without AI (holds by construction; AI itself not built) |
| T091 | tested | apps/api/test/d-integrity.test.ts › T091 (clean DB + idempotent rerun, checksums); 0006 applied over 0001–0005 schema |
| T092 | partial | apps/api/test/d-integrity.test.ts › T085/T092 (worker retry/restart). PostgreSQL restart drill not run |
| T093 | partial | scripts/restore-drill.sh run on demo DB: 6/6 checks OK, dump 0.29 s, restore 1.35 s. Media and production-size RPO/RTO not measured |
| T094 | tested | apps/api/test/global-setup.ts creates a fresh PostgreSQL DB; 0 skipped tests |
| T095 | not_started | Load profile (10k SKU/100k orders) not executed |
| T096 | implemented | .github/workflows/ci.yml: gitleaks + pnpm audit + full authz suite; CI run on GitHub not yet observed. Local `pnpm audit --prod --audit-level high`: 0 high (2 moderate) |
| T097 | partial | apps/api/test/d-integrity.test.ts › T012/T097 (prod config: no OTP echo, mock off); seed refuses NODE_ENV=production |
| T098 | tested | apps/api/test/c-partner.test.ts › T098 |
| T099 | tested | apps/api/test/c-partner.test.ts › T099 |
| T100 | manual | docs/TEST_REPORT.md + PR description reference the exact commit; no merge/deploy performed |

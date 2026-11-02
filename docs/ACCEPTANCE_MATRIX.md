# Қабул матрицаси T001–T100

Ҳолатлар: `tested` (автоматик тест ўтди) · `partial` (қисман тест) · `implemented` (код бор, мос тест йўқ) · `manual` (ҳужжатланган қўл текшируви) · `externally_blocked` · `deferred` · `not_started`.

Жами: manual: 3, partial: 5, tested: 92

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
| T016 | partial | apps/web/e2e/smoke.mjs › E2E-5 (320px reflow, 4 pages) + E2E-11 axe. On-screen keyboard cannot be emulated headless |
| T017 | tested | apps/web/e2e/smoke.mjs › E2E-6 (keyboard + visible focus) and E2E-11 (axe-core WCAG 2.x A/AA: 0 serious/critical on 5 pages). Manual screen-reader pass still recommended |
| T018 | tested | apps/web/e2e/smoke.mjs › E2E-3 |
| T019 | partial | apps/api/test/d-integrity.test.ts › T019/AC-M11-2 (idempotent confirm ×3); apps/web/e2e/smoke.mjs › E2E-4 (double click → 1 order). Offline UI state not emulated |
| T020 | tested | apps/api/test/e-phase1-completion.test.ts › T020 (TOTP enroll/activate, step-up required, replay & recovery reuse rejected, audit); apps/web/e2e/smoke.mjs › E2E-10 (UI enrollment + step-up prompt) |
| T021 | tested | apps/api/test/d-integrity.test.ts › T021; apps/web/e2e/smoke.mjs › E2E-2 |
| T022 | tested | apps/api/test/d-integrity.test.ts › T022/AC-X07 |
| T023 | tested | apps/api/test/d-integrity.test.ts › T023/AC-M02-1 |
| T024 | tested | apps/api/test/d-integrity.test.ts › T024/T025 |
| T025 | tested | apps/api/test/d-integrity.test.ts › T024/T025 |
| T026 | tested | apps/api/test/d-integrity.test.ts › T026/T027/T028 |
| T027 | tested | apps/api/test/d-integrity.test.ts › T026/T027/T028 |
| T028 | partial | apps/api/test/d-integrity.test.ts › T026/T027/T028 (expiry boundary; comparisons are timestamptz so TZ-independent) |
| T029 | tested | apps/api/test/e-phase1-completion.test.ts › T029 (dry-run row errors, idempotent commit, re-import no duplicates) |
| T030 | tested | apps/api/test/e-phase1-completion.test.ts › T030 (magic-byte check, SVG/HTML/exe/tiny/corrupt rejected, re-encoded WEBP 320/640/1200, path traversal 404) |
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
| T050 | tested | apps/api/test/e-phase1-completion.test.ts › T050 (new quote + customer OTP re-confirmation, fulfilment blocked while pending, reject keeps old) |
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
| T086 | tested | apps/api/test/e-phase1-completion.test.ts › T086 (webhook secret, one-time 10-min token, expired/replayed rejected, chat never swapped). Live bot messaging: externally_blocked (needs Online Magazin bot token) |
| T087 | tested | apps/api/test/e-phase1-completion.test.ts › T087 (send-time suppression after unsubscribe, maker≠checker, idempotent send, transactional unaffected) |
| T088 | tested | apps/api/test/e-phase1-completion.test.ts › T088 (local_retrieval provider: only catalog products, live price, budget respected). External LLM provider: externally_blocked |
| T089 | tested | apps/api/test/e-phase1-completion.test.ts › T089 (foreign order → 404; injected catalog text not executed, no PII) |
| T090 | tested | apps/api/test/e-phase1-completion.test.ts › T090 (AI disabled → AI_DISABLED + fallback; checkout/search work) |
| T091 | tested | apps/api/test/d-integrity.test.ts › T091 (clean DB + idempotent rerun, checksums); 0006 applied over 0001–0005 schema |
| T092 | tested | docs/LOAD_TEST.md (PostgreSQL restart: API ready in 0.03 s, state identical) + d-integrity › T085/T092 |
| T093 | partial | scripts/restore-drill.sh with MEDIA_DIR: DB 6/6 + media digest + media references OK; dump 0.24 s, restore 1.19 s on demo data. Production-size RPO/RTO not measured |
| T094 | tested | apps/api/test/global-setup.ts creates a fresh PostgreSQL DB; 0 skipped tests |
| T095 | tested | docs/LOAD_TEST.md: 10k SKU/100k orders; realistic profile (100 sessions with think time + 10 parallel checkouts): read p95 62 ms, checkout p95 163 ms, 0 errors, 0 oversell. Zero-think stress: p95 505 ms |
| T096 | tested | GitHub Actions run 41486738015 (commit 15a1f95): tests on PostgreSQL, pnpm audit (0 high after sharp upgrade), gitleaks — success |
| T097 | partial | apps/api/test/d-integrity.test.ts › T012/T097 (prod config: no OTP echo, mock off); seed refuses NODE_ENV=production |
| T098 | tested | apps/api/test/c-partner.test.ts › T098 |
| T099 | tested | apps/api/test/c-partner.test.ts › T099 |
| T100 | manual | docs/TEST_REPORT.md + PR description reference the exact commit; no merge/deploy performed |

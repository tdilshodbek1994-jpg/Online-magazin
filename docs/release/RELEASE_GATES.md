# Release gates — evidence (code side)

Status per gate: **CODE_EVIDENCE** = automated tests on real PostgreSQL exist (local + CI workflow); **OWNER/EXTERNAL** = needs the owner, a provider, a device or a lawyer — Claude cannot close it. Nothing here is «approved for production»; that is the owner's decision.

| Gate | Status | Evidence | Still needed |
|---|---|---|---|
| G01 Scope & contract | CODE_EVIDENCE | `docs/release/STATUS.md`, `docs/BUSINESS_RULES.md`, fixtures B01–B06 (`zo-release-fixtures`) | owner: 4+ units rule, hold days (14 = demo), level gift discounts |
| G02 Identity/permissions | CODE_EVIDENCE | d-integrity T006/T007 (operator cannot pay/approve), e-phase1 T020 (MFA/step-up), zn-aibiz (customer has no business AI, report IDOR 404, strict schemas) | revoked-session test (PR-09) |
| G03 Two order paths | CODE_EVIDENCE | c-partner (referral + on-behalf, operator call confirms), l-sales-drafts (fill link), q-ops-center | real phones (manual checklist A07–A10) |
| G04 Quote/inventory | CODE_EVIDENCE | d-integrity T051 (stock=1, 20 parallel → 1), T023–T026 (reprice), idempotency T019 | — |
| G05 Fulfilment/COD | CODE_EVIDENCE | d-integrity T057 (collected vs remitted), c-partner delivery flows | real courier pilot |
| G06 Payment/refund | OWNER/EXTERNAL | refunds: d-integrity T068–T070 (no over-refund, unknown keeps reserve); online payment provider not connected | provider contract + sandbox + owner-limited live test |
| G07 Rewards/accounting | CODE_EVIDENCE | zb/ze/zd/zc/zm suites, B04/B05 return reprice, ledger rebuild (T078–T080) | accountant sign-off on UzCoin liability |
| G08 Privacy/legal/fiscal | OWNER/EXTERNAL | legal document versions + acceptances, consents (T087) | lawyer-approved texts, fiscal provider, retention policy |
| G09 Recovery | OWNER/EXTERNAL | `scripts/backup.sh`, `scripts/restore-drill.sh` (money/stock invariants) | run the drill on a copy of the real server |
| G10 Security/build | CODE_EVIDENCE | `.github/workflows/ci.yml` (typecheck, tests on Postgres 16, gitleaks, audit), migration checksums T091 | latest CI run link for the release SHA |
| G11 Devices/performance | OWNER/EXTERNAL | `scripts/load/*`, phone-width screenshots during development | Android/iPhone checklist on real devices |
| G12 Operations | OWNER/EXTERNAL | `/health/live`, `/health/ready`, feature-flag kill switches (`ai.business.read`, `ads.live_spend`, …), `docs/OPERATIONS.md` | named on-call person, alert channel |
| G13 Test-data isolation | CODE_EVIDENCE | tests use isolated DBs (`setupIsolatedApp`), demo flags documented | owner: turn demo data off before pilot |

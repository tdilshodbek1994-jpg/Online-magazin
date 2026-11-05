# Final release — capability status (PR-01)

Branch `claude/online-marketplace-platform-sdtv52`. Status values: exists_verified (code + an automated test names it) · partial · missing · blocked_external · deferred.
Evidence paths: API `apps/api/src/modules/…`, tests `apps/api/test/…`, web `apps/web/app/…`. This table was built from routes, migrations and test titles; «verified» means a test exercises it on real PostgreSQL in the local/CI suite.

| M | Status | Evidence | Gap → plan |
|---|---|---|---|
| M01 Business rules | exists_verified | `commissions/service.ts` (`matrixUnitAmounts`, `computeOrderTargets`), `zo-release-fixtures` (B01–B06), `n-ad-analytics`, `ze-uzcoin`, `zd-charity-center`, `zc-quality-center` | 4+ units: no approved rule → review (by design) |
| M02 Audit/status | exists_verified | this file, `docs/STATUS.md`, `docs/*_STATUS.md` | — |
| M03 Order timeline | partial | `order_status_events`, `/me/orders/:id`, `/partner/orders/:id/passport` (milestones) | one shared status dictionary doc — PR-04 |
| M04 Today work center | partial | `/partner/attention`, `/partner/dashboard`, `/ops/center/board`, `admin/overview.ts` | owner/warehouse/finance «today» — owner part via M24 |
| M05 Customer login/recovery | partial | `/auth/otp/*`, `/auth/sessions`, `/auth/logout` (d-integrity T009–T011) | phone change flow — PR-02 |
| M06 Catalog | partial | `/products` cyr/lat search, `/waitlist`, `/price-watch` | favorites device-only (P1) |
| M07 Cart/quote | partial | `/cart`, `/checkout/quotes`, `/delivery-zones` (d-integrity T023–T026) | delivery slots/cutoff — owner decision (no tariffs given) |
| M08 Where is my order | partial | `/me/orders/:id`, `web/app/orders/[id]` | signed minimal status link — PR-02 |
| M09 Edit/cancel/reorder | partial | Reorder, `/ops/orders/:id/amendments` (T050) | customer self-cancel before confirmation — PR-02 |
| M10 Returns | partial | `returns/routes.ts`, `/refunds/*` (d-integrity T068–T070) | customer returns page; exchange flow |
| M11 Notifications | partial | `notifications/service.ts`, `/me/consents` (T087), ops night guard | SMS blocked_external; customer quiet hours P1 |
| M12 Partner start/kit | partial | `/partner/apply`, ad texts, market | onboarding checklist P1 |
| M13 On-behalf order | exists_verified | `/partner/orders/*`, `/confirm/:token`, drafts (c-partner, l-sales-drafts) | operator call confirms (owner flag) |
| M14 Offer/fill link | exists_verified | `/fill/:token`, `/offer/:token/*` (l-sales-drafts, m-partner-p2) | — |
| M15 Partner money | exists_verified | `/partner/wallet`, `/partner/ledger`, `/partner/disputes`, monthly report | — |
| M16 Flow/landing/ads | exists_verified | landings/tracking/target (zf–zl, zi) | live Meta blocked_external |
| M17 Operator desk | exists_verified | `/ops/center/next|claim|heartbeat|release` (q-ops-center) | — |
| M18 Support/handoff | exists_verified | support, r-ops-handoff, v-duplicates | — |
| M19 Lead/bulk assign | exists_verified | `/ops/center/bulk/assign` preview→apply (T53) | team membership history model — P1 |
| M20 Warehouse | partial | pick/pack/ship, return inspect, inventory movements | barcode scan UI P1 |
| M21 Delivery/COD | partial | zones, courier, `/finance/remittances` (T057) | slots need owner tariffs |
| M22 Replenishment | missing | `/admin/stock/low` only | P1 — supplier PO draft |
| M23 Admin content/import | exists_verified | imports preview/commit (T029), media (T030) | bulk price edit P1 |
| M24 Owner decisions center | partial | commission review, quality inbox, incidents | one owner page — PR-08 |
| M25 Finance close | partial | journal, `/finance/exceptions`, month close | daily close P0; fiscal blocked_external |
| M26 Rewards together | exists_verified | zb/ze/zd/zc/zm suites | — |
| M27 Reviews/service | partial | reorder, also-bought, templates | reviews P1 |
| M28 Automation builder | missing | ad safety rules only | P1 |
| M29 Search/bulk/export | partial | bulk assign, CSV exports | global search P1 |
| M30 Security | exists_verified | MFA, step-up (T020), role checks (T006/T007), staff revoke | revoke test — PR-09 |
| M31 Design/offline | partial | sw.js, offline page, dark mode | offline drafts P1 |
| M32 AI | exists_verified | `aibiz/*` (zn-aibiz 40 tests) | live LLM key external |
| M33 Outbox/idempotency | exists_verified | outbox, idempotency records (T019/T085/T049) | inbox table unused |
| M34 Legal/consent/deletion | partial | legal versions + acceptances, consents | data deletion request — PR-02; legal text = lawyer |
| M35 Monitoring | partial | `/health/live`, `/health/ready`, OPERATIONS.md | integration health page — PR-09 |
| M36 Backup/restore | exists_verified | `scripts/backup.sh`, `scripts/restore-drill.sh` (invariants), migration checksums (T091) | drill on the real server — owner |
| M37 Performance | partial | `scripts/load/*`, LOAD_TEST.md | real-device measurement |
| M38 Tests/CI | exists_verified | `.github/workflows/ci.yml` (Postgres 16, no skips, gitleaks) | browser E2E in CI |
| M39 Small PRs | partial | `*_HANDOFF.md` | — |
| M40 Release gates | partial | `docs/release/RELEASE_GATES.md` | owner approvals |

## Fixtures B01–B16 → tests
B01–B06, B14: `zo-release-fixtures`. B07 (wallet bridge): c-partner T078–T080 ledger rebuild. B08 (charity 1%): zd-charity-center #1+#2. B09 (100×3 000): ze-uzcoin #6. B10 (COD 200k/150k): d-integrity T057 remittance. B11 (FX after-ad): n-ad-analytics. B12 (refund limit): d-integrity T068/T069. B13 (coin double spend): ze-uzcoin #19 + #10. B15 (averages are not per-link claims): no screen makes that claim. B16 (last unit): d-integrity T051 (stock=1, 20 parallel checkouts → 1 reservation); gift stock is a separate pool in the UzCoin shop (ze-uzcoin #10).

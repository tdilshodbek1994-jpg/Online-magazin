# Claude учун кичик PRлар режаси

Муддат ваъдаси эмас; боғлиқлик ва қабул тартиби. Ҳар PR тайёр қисмни қайта ёзиш эмас, аудит натижасига мос patch.

## PR-01 — Аудит ва релиз қамрови
Модуллар: M01, M02, M39, M40.
Натижа: Repository map, capability status, approved/deferred decisions; код борлигини ва ҳақиқатан ишлашини ажрат.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## PR-02 — Quote, order ва мижоз кириши
Модуллар: M03, M05, M07, M30.
Натижа: Бир маҳсулотдан бир order, stock collision, real auth ва reprice tests.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## PR-03 — Ҳамкорнинг икки сотув йўли
Модуллар: M12, M13, M14, M16.
Натижа: Referral ва on-behalf; контекстли draft; мустақил customer confirmation; privacy.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## PR-04 — Операторнинг ягона иш столи
Модуллар: M04, M17, M18, M19.
Натижа: Atomic assignment, callback, handoff ва role-scoped timeline.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## PR-05 — Омбор, етказиш ва қайтариш
Модуллар: M08, M10, M20, M21.
Натижа: Pick/pack, partial delivery/return, COD remittance ва customer status.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## PR-06 — Молия ва мукофотларни солиштириш
Модуллар: M15, M25, M26, M33.
Натижа: Бир ledger truth, payout/refund unknown, coin/charity/correction trace ва E2E.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## PR-07 — Мижоз ва ҳамкор қулайликлари
Модуллар: M06, M09, M22, M27, M29.
Натижа: Saved/reorder, restock, replenishment draft, report/export; N/A features очиқ.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## PR-08 — Админ тасдиқлари ва хабарлар
Модуллар: M11, M23, M24, M28, M31.
Натижа: Контекстли импорт, exception inbox, notification policy, shadow automation, responsive UX.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## PR-09 — AI, хавфсизлик ва тиклаш
Модуллар: M32, M34, M35, M36.
Натижа: AI allowlist, lawful/data gates, integration health, restore/reconcile evidence.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## PR-10 — Release candidate ва қабул
Модуллар: M37, M38, M39, M40.
Натижа: Якуний SHA, real DB/device/provider results, flags, runbook, owner approval.
Қабул: тегишли AC сценарийларини test implementation/далилга боғла; CI current SHA; secrets/demo data йўқ.
HANDOFF: SHA, changed files, commands/results, risks, next task.

## Қайси қулайликлар биринчи?
Энг биринчи on-behalf ва referral тўлиқ занжири. Кейин customer tracking, operator callback, earnings explanation. Forecast ва native app кейинги backlog; launch-critical хатолардан устун эмас.

## STATUS/HANDOFF намунаси
Release/branch/commit:
Audit evidence:
Completed verified modules:
Partial/blocked/deferred modules:
Changed paths:
Test commands and exit codes:
Passed/failed/skipped + reasons:
External provider test scope:
Open decisions:
Next exact task:
Flags/migration/rollback:
Owner approvals obtained (scope):

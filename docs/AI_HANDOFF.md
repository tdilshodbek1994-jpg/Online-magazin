# AI Business Assistant — handoff

- Repo / branch: `tdilshodbek1994-jpg/Online-magazin` · `claude/online-marketplace-platform-sdtv52`
- Migration: `0039_ai_business_assistant.sql` (forward-only; applied by the normal deploy migrate step)
- Code: `apps/api/src/modules/aibiz/{text,dates,intent,tools,routes}.ts`, registered in `app.ts`; web `apps/web/app/partner/ai/page.tsx`
- Contracts and owner package: `docs/ai/`
- Status table: `docs/AI_STATUS.md`

## How it works (P0A)
`POST /ai/biz/ask {text, session_id?}` → principal from the session (partner id from `partners.user_id`) → refusal check → intent + period → one allow-listed tool → facts → deterministic summary → stored in `ai_report_snapshots` → card. `POST /ai/biz/tool` runs the same tools with explicit, strictly validated arguments. `GET /ai/biz/reports/:id` re-authorises. No model is called in P0A.

## Commands run (local, real PostgreSQL 16)
- `npx tsc --noEmit` (api, web) — exit 0
- `npx vitest run test/zn-aibiz.test.ts` — 28 passed
- full `npx vitest run` — see the commit message / AI_STATUS for the latest count
- `npm run build` (web) — compiled; manual phone-width check of `/partner/ai` (quick questions, Cyrillic question, refusal card)

CI was not run by Claude for this change; local results are not CI.

## Next exact task (P0B)
1. Operator workspace: own queue (`ops_tasks` assigned to me, overdue callbacks, attempts from `call_logs`), own accept/reject stats.
2. Superadmin/admin: sales summary (orders/units/revenue by state), COD pending vs collected vs remitted, inventory health — gated by existing permissions (`reports.read`, `payments.read`, …).
3. LLM intent via `modules/ai/claude.ts` pattern: structured output limited to the registry tool names and argument schema; numbers still only from tools; flag `ai.business.llm`.
4. Map `docs/ai/tests/acceptance_cases.json` to code tests.

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
- P0B: `npx vitest run test/zn-aibiz.test.ts` — 36 passed; full `npx vitest run` — 39 files, 331 tests passed, exit 0
- `npm run build` (web) — compiled; manual phone-width check of `/partner/ai` (quick questions, Cyrillic question, refusal card)

CI was not run by Claude for this change; local results are not CI.

## Turning on the real AI (owner, on the server — never paste the key in chat)
1. In the server environment file add `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=<key>` (optional `AI_BIZ_MODEL`, default `claude-opus-5-5`), restart via the normal deploy script.
2. Admin → feature flags → turn on `ai.business.llm`.
3. Kill switch: turn off `ai.business.llm` (AI routing) or `ai.business.read` (whole assistant); the shop keeps working.

## Next exact task
1. Contest rank from `cc_rankings` in `partner_contest_status`.
2. Team model (lead workspace) if the owner wants operator leads.
3. P1: export of a stored report revision (same numbers as the screen), voice transcript preview.

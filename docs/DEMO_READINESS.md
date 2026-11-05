# DEMO deployment readiness — Vultr 192.248.191.30 (1 vCPU / 2 GB RAM / 25 GB NVMe, Ubuntu 24.04)

**Status: ready to deploy as a password-protected DEMO, pending owner approval and three owner-side steps (SSH key, DNS, GitHub secrets). Nothing has been deployed; no connection to the server was made.**

## 1. Repository analysis
| Component | Finding |
|---|---|
| Repository / branch | `tdilshodbek1994-jpg/Online-magazin`, work on `claude/online-marketplace-platform-sdtv52`; `main` contains only the initial commit and is untouched |
| Frontend | Next.js 16 (standalone output), uz-Latn/uz-Cyrl |
| Backend | Fastify 5 + TypeScript modular monolith; durable jobs in PostgreSQL |
| Database | PostgreSQL 16, migrations `0001–0008` (forward-only, checksum-protected), synthetic demo seed (refuses production) |
| Redis | **Not used** by design (PostgreSQL is the queue and source of truth) — nothing to disable |
| AI | No local model. Optional external **Claude API** (`@anthropic-ai/sdk`, model `claude-opus-5-5`, configurable via `AI_MODEL`); off unless `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` and the `ai.enabled` flag |
| Docker | `api`, `web` images; Compose base + `prod` (Caddy HTTPS) + **new `demo`** overlay |

## 2. DEMO configuration for 2 GB RAM (`docker-compose.demo.yml`)
- Services started: `om-postgres`, `om-migrate` (one-shot), `om-api` (worker runs in-process), `om-web`, `om-caddy`. Separate `om-worker` disabled.
- PostgreSQL: `shared_buffers=128MB`, `max_connections=40`; memory limits: postgres 448 MB, api 384 MB, web 320 MB, caddy 96 MB.
- Site behind HTTP basic auth (`Caddyfile.staging`) because the DEMO shows SMS codes on screen; payment callbacks bypass the password and authenticate themselves.
- `scripts/server/bootstrap-demo.sh`: 2 GB swap, Docker, `om` user, UFW (22/80/443), fail2ban, unattended upgrades, key-only SSH (only once a key is present).

## 3. Measured on the exact DEMO topology (locally, Caddy + password + limits)
| Check | Result |
|---|---|
| Image sizes | api 463 MB, web 411 MB, postgres 617 MB, caddy 70 MB (~1.6 GB of 25 GB) |
| Idle memory (4 containers) | ~233 MB |
| Peak memory under 30 s load (50 sessions) | **262 MB total** (postgres 108, api 53, web 58, caddy 43) |
| Read latency under that load | p50 8 ms, p95 22 ms, 0 errors |
| Browser E2E through Caddy + basic auth | **13 / 13 passed** (incl. AI assistant + kill switch, axe-core WCAG scan, offline checkout, MFA step-up) |
| Without password | 401; with password 200; Payme callback reachable without password and rejected by Payme auth (-32504) |
| API tests (real PostgreSQL) | **81 / 81 passed** |
| One-command local DEMO | `scripts/demo-local.sh --build` → 4 services up, seed loaded |

## 4. Problems found and fixed while preparing
1. No `.dockerignore`: local `node_modules` leaked into the web image and broke `next build`.
2. Basic auth and the app session both used the `Authorization` header — logged-in users were blocked behind the DEMO password. The web app now sends `X-Session-Token`; API clients may still use `Authorization: Bearer`.
3. Caddy directive order put payment callbacks behind the password; fixed with explicit `handle` blocks.
4. The bcrypt password hash contains `$` and was mangled by Compose interpolation; documented single quotes in `.env`.

## 5. Connection method (SSH key, nothing via chat)
1. On **your computer**: `ssh-keygen -t ed25519 -C "uzshop-demo"`.
2. Vultr console → server → **View Console** (web console) as root → append the **public** key (`~/.ssh/id_ed25519.pub`) to `/root/.ssh/authorized_keys`.
3. Run `scripts/server/bootstrap-demo.sh` on the server (copy the file or `curl` it from the branch). It disables password login only after the key is present.
4. Deploy without anyone handling your private key: create a separate **deploy key** pair, add its public key to `/home/om/.ssh/authorized_keys`, and put the private key in GitHub → Settings → Secrets → Actions as `DEMO_SSH_KEY` (+ `DEMO_SSH_HOST`, `DEMO_SSH_USER=om`, `DEMO_SSH_KNOWN_HOSTS` from `ssh-keyscan -t ed25519 192.248.191.30` checked against the Vultr console, `DEMO_ENV` = server `.env`).
5. Deployment = manual workflow **deploy-demo** (Actions tab → Run workflow → type `DEPLOY-DEMO`). It builds images on the GitHub runner (no build load on the 2 GB server), takes a DB backup if one exists, starts the stack, optionally seeds demo data, and prints memory usage.

From this sandbox, port 22 of 192.248.191.30 is **not reachable**, so I cannot connect directly; the workflow above is the intended path.

## 6. Opening in the browser
- With DNS (`uzshop.net` A records → 192.248.191.30): `https://uzshop.net` (automatic Let's Encrypt certificate), login with the DEMO password, then demo phones `+998900000001…08` (OTP shown on screen).
- Remote smoke test from any machine: `WEB_URL=https://uzshop.net E2E_BASIC_AUTH=owner:<password> node apps/web/e2e/smoke.mjs`.
- Without a domain, HTTPS certificates are not possible on a bare IP with this setup; a plain-HTTP IP demo would send the password unencrypted, so it is not recommended.

## 7. Open items before running the deployment (owner)
| # | Item | Needed for |
|---|---|---|
| 1 | Approve the deployment | everything |
| 2 | Add SSH key on the server and run bootstrap | secure access |
| 3 | DNS: `uzshop.net` and `www` A records → 192.248.191.30 | HTTPS |
| 4 | GitHub secrets (`DEMO_SSH_*`, `DEMO_ENV`) | workflow deployment |
| 5 | Optional: `ANTHROPIC_API_KEY` (+ `AI_PROVIDER=anthropic`) | external AI in DEMO |

Server plan unchanged (1 vCPU / 2 GB is sufficient for the DEMO by measurement); no other servers touched.

# 03 — brain-ui: Auth, Deployment, Encryption, Hosting Skill

Status: approved plan · Date: 2026-07-12 · Prereq reading: 00-overview.md, research/brain-ui-analysis.md, 04-extensibility.md (§3–6 define the ui-sdk work also landing in this repo)

brain-ui goes public as a fresh-history repo (old private repo archived). It stays a separate repo versioning independently against the brainform integration contract.

## 1. Auth (built-in password at launch — user decision)

- **`AUTH_MODE=password` (new, default for public exposure)**: argon2/bcrypt hash via `BRAIN_UI_PASSWORD_HASH` env (+ `bun run hash-password` helper), signed HttpOnly session cookie, rate-limited login route, guard applied to `/api/*` AND the WebSocket upgrade — same insertion points where `tailscaleGuard` sits today (`server/src/app.ts:43-46`). Login screen in the client. Only option where `docker compose up` on a bare VPS is safe with no extra moving parts. Estimated 1–2 days.
- **`AUTH_MODE=tailscale`**: today's model, kept as the easy path. **Must fix first**: `server/src/middleware/tailscale.ts` trusts `x-forwarded-for` unconditionally — spoofable when the port is exposed without a trusted proxy. Gate header trust behind `TRUST_PROXY=1`, otherwise use the socket address. Document Tailscale Serve as the zero-compose variant.
- **`AUTH_MODE=proxy`**: brain-ui trusts an upstream auth header; document ONE worked example (Authelia / oauth2-proxy / Caddy basic_auth), build no integrations.
- **`AUTH_MODE=none`**: refused when `NODE_ENV=production` unless `HOST` is loopback. Fail closed — never ship a default that exposes an agent with write access to someone's life.

## 2. Deployment generalization

- **Same-origin as the default topology.** Verified: production already serves `client/dist` from the server (`app.ts:60-64`) and `getWsUrl()` falls back to `window.location`. Work: build the Docker image WITHOUT `VITE_BACKEND_URL`; `API_BASE` defaults to `/api`; replace the hardcoded CORS origin (`app.ts:32`, `brain.schlesser.net`) with `ALLOWED_ORIGINS` env (empty = same-origin = CORS middleware skipped). Alain's split topology (public frontend, Tailscale-only backend) becomes a documented advanced configuration that keeps the build-arg.
- **Vendor-neutral `docker-compose.yml`**: brain-ui service + optional `caddy` service (3-line Caddyfile → auto-HTTPS), named volumes instead of `/opt/brain-ui/*` host paths, no external `coolify` network; sshd/port-2223 behind an opt-in compose profile (`--profile ops`). Keep the Coolify compose as a documented example; Traefik-labels example in docs.
- **Cron by module**: `config/crontab` currently hardcodes the personal job-scrape line. The entrypoint generates the crontab: sync/index/validate/maintain always; module lines appended from enabled modules' `cron` manifests (01 §3).
- **Dockerfile**: scrub LABEL maintainer; consider `slim`/`full` targets (Chrome + gh + Gemini CLI are module-driven weight — jobs scraping needs Chrome; decide when measuring in this phase).

## 3. Encryption exploration (user-requested)

Honest framing up front: **true E2E is incompatible with a server-side agent that must read plaintext to operate.** Scope realistically:

1. **At-rest**: encrypted volume (LUKS or provider volume encryption) as the documented default for VPS deployments.
2. **Encrypted backups**: restic/borg with encryption — easy win; document + optional compose service.
3. **Encrypted git remote** for the content repo (git-remote-gcrypt or age-encrypted bundles) as a documented pattern — post-launch.
4. **SQLCipher for brain.db**: evaluate, likely reject — the db is derived and regenerable; the markdown is the sensitive artifact.
5. SECURITY.md states plainly what each mode does and does not protect.

Pre-launch deliverable: a short decision doc + implemented docs for (1)+(2).

## 4. `/brain-host` skill

Interview: what do you want? (a) private GitHub backup only, (b) VPS with public HTTPS, (c) home server / Tailscale-only, (d) fly.io, (e) nothing.

| Concern | Automates | Documents |
|---|---|---|
| GitHub private repo | `gh auth status` → `gh repo create --private` → push → verify visibility | PAT scopes for the container (`GITHUB_TOKEN`) |
| Env generation | writes `.env` for the compose stack from answers (auth mode, domain, tokens, TZ); generates password hash | where each key comes from (CLAUDE_CODE_OAUTH_TOKEN setup-token flow is already well documented in `.env.example` — reuse) |
| VPS | generates a copy-paste runbook (provision → DNS → `docker compose up` → healthcheck curl); may drive it command-by-command over SSH with consent | Hetzner walk-through (genericized DEPLOYMENT.md successor), fly.io variant, DNS, backups |
| Tailscale/home | compose without Caddy, `AUTH_MODE=tailscale`, TRUST_PROXY notes | Tailscale install + Serve |
| Validation | `curl /api/health`, login check, one chat round-trip via the UI | troubleshooting table |

**Honest cost table for docs**: VPS €4–6/mo (Hetzner entry tier) or $0 home server; the model is the dominant cost — Claude backend: Max $100–200/mo or Pro $20 (tight); pi backend: any API key at per-token rates, OpenRouter, or $0 local models (Ollama/vLLM) at reduced quality; Gemini embeddings ≈ $0 (free tier covers a personal corpus); Deepgram optional (free credit, then cents/hour); domain ~$10/yr. State plainly: "the AI usually costs more than the hosting."

## 5. brain-ui scrub list (before the public repo is cut)

All verified locations — see research/brain-ui-analysis.md for detail:

1. Rotate the real Deepgram key in the working-tree `.env` (not in git history, but cheap insurance; the public repo gets fresh history anyway).
2. `docs/DEPLOYMENT.md` → replaced by generic `docs/hosting/`; personal bits (VPS IP `91.99.200.114`, Coolify URL/UUID) move into the private brain under `infrastructure/`.
3. `client/src/lib/backend.ts` — comments contain `brain.schlesser.net` and the tailnet hostname; rewrite with the same-origin change.
4. `server/src/app.ts:32` — hardcoded CORS domain (fixed by ALLOWED_ORIGINS work).
5. `Dockerfile:40` LABEL maintainer; `docker-compose.prod.yml` `BRAIN_REPO_URL` default `schlessera/brain.git`.
6. `.env.example` — placeholder-only today (verified), but re-read line-by-line at cut time; genericize tailnet examples and GIT_USER_NAME.
7. `server/tests/` fixtures — audit for personal content (e.g. name in `brain-client.test.ts:120`).
8. Client PWA manifest name/icons, page titles.
9. Final gate: leakage grep (`alain|schlesser|carole|buffy|wyvern`) across the public tree (also a CI job — 06-launch).

## 6. Repo hygiene to add

- README (currently absent — CLAUDE.md is the de-facto readme).
- CI: typecheck, unit tests, `docker build`, contract test against the pinned `@brainform/core` (the live contract test INTEGRATION.md recommends — currently only a mocked test exists at `server/tests/unit/brain-client.test.ts`), one smoke test per inference-profile type (env-remap fragility).
- SECURITY.md — the important one of the two repos (06-launch §SECURITY).

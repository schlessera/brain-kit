# Research: brain-ui analysis

Source: read-only exploration of `/home/alain/dev/brain-ui`, 2026-07-12. ~13,300 LoC ts/tsx (95 .ts, 33 .tsx), 157 tracked files, 79 commits (2026-04-06 → 2026-07-11) — actively developed. No root README; CLAUDE.md is the de-facto readme.

## What it is

PWA chat interface to Claude Code, scoped to a personal brain repo. Stack: Vite + React + TS + assistant-ui + shadcn/ui + Tailwind v4 + service worker (client); Hono on Bun, WebSocket streaming + SSE (server); `@anthropic-ai/claude-agent-sdk` headless (`server/src/claude/session.ts:1-8`). Bun workspaces: `shared/` (protocol types), `server/`, `client/`.

Features: chat with per-tool approval cards (`canUseTool` bridge, `session.ts:152-158`), risk hints, per-tool timeline renderers; file tree/viewer reading the brain repo (`server/src/files/walker.ts`); voice dictation (Deepgram Nova-3 streaming); "What's up" briefing + brain sync over SSE (`routes/brain.ts`); brain search/list/add/stats REST; share-to-OS via server-side Puppeteer render; `get_current_location` MCP tool bridged to browser geolocation; switchable inference providers (Anthropic/OpenRouter/Cerebras, `claude/providers.ts`); image attachments; single active session with serial queue (`session.ts:82-108`).

## Coupling to the brain repo (all keyed off `BRAIN_PATH`, default `${HOME}/brain`, `/data/brain` in container)

- **Spawns the brain CLI**: `Bun.spawn(["bun", "scripts/brain-cli.ts", ...], {cwd: BRAIN_PATH})` (`server/src/brain/client.ts:19`); wraps search/briefing/stats/list/read/sync/add/index/validate; parses JSON on non-TTY (`NO_COLOR=1`); tolerates the 2026-07-03 `{results, warnings}` envelope change (`client.ts:64-66`). Also spawns `scripts/whatsup.ts --gemini` (`routes/brain.ts:76`) and `bash -c "bun scripts/brain-cli.ts sync"` (`routes/brain.ts:181`).
- **Direct FS reads** of the repo (`files/walker.ts:28-29`, honors .gitignore, excludes .git/node_modules/*.db/dotfiles).
- **Direct SQLite read of brain.db** read-only for voice keyterms (`voice/keyterm-builder.ts:373-379`).
- **Claude sessions run inside the brain repo**: cwd=BRAIN_PATH, `settingSources: ["project"]` loads the brain's CLAUDE.md + skills (`session.ts:135-159`); SDK JSONL history under BRAIN_PATH (`listSessions({dir: BRAIN_PATH})`, `session.ts:259-269`); history normalization inline at `ws/handler.ts:512-650` (`buildSessionHistory`).
- **Cron** (`config/crontab:8-17`): sync+index 02:00, validate 03:00, jobs scrape 04:00 (`scripts/jobs/scrape-all.ts --api-only`), `brain maintain` 07:00.
- Honors `scripts/INTEGRATION.md` (named as consumer at its line 12). Gap: the recommended live contract test isn't implemented — `server/tests/unit/brain-client.test.ts` mocks the CLI.

## Wire protocol (shared/protocol.ts) — ~90% agent-neutral

`text_delta`, `thinking_delta`, `tool_use_start/input_delta/complete`, `tool_result`, `tool_approval_request`, `result` (cost/turns), `error`, `status`, `session_info`, `session_history`; neutral `MessagePart` model (lines 77–204). Claude residue: `ProviderInfo.provider: "anthropic"|"openrouter"|"cerebras"` union (`:210`); AskUser doc-comment mentions the Claude SDK (`:386`) though the shape (question/header/options/multiSelect) is generic. SDK→protocol translation isolated in `server/src/claude/stream-adapter.ts` (per-session stateful class). AskUser/location bridged via in-process MCP server (`session.ts:129-151`). `AsrEvent` also lives in the protocol (`:295-301`).

## Tool rendering (client/src/components/chat/tool-views.tsx)

Dispatches on Claude tool names: icon map `:84-98`, summary switch `:117-166`, input switch (Edit/Write/Bash/Read) `:228-250`, output switch (Agent/WebFetch/Grep/Glob/Read/WebSearch) `:585-606`. Graceful fallbacks exist: `KeyValueView:548`, `ClampedPre:613`, MCP demangling `getToolLabel:108-114`, `computeDiffRows:364`, `splitGrepRow:730`. Consumed only via `tool-call-timeline.tsx:15-22,222,259` against neutral `ToolCall` store type (`chat-store.ts:45-60`).

## Voice

Server: `voice/deepgram-token.ts` (token mint; "single-user-behind-Tailscale model" comment `:5`), `routes/voice.ts:7-17` `/voice/token`; `voice/keyterm-builder.ts` provider-agnostic (reads brain.db → generic keyterms). Client: `voice/asr-deepgram.ts` hardcodes `wss://api.deepgram.com/v1/listen` (`:24`) + nova-3 params (`:36-45`) but surface (start/stop/drainAndStop, AsrEvent) is neutral; `use-dictation.ts` instantiates DeepgramClient directly.

## Inference providers

`server/src/claude/providers.ts`: five hardcoded `ProviderConfig`s (`:44-95`) working by env-var remap of the Claude Code process (`ANTHROPIC_BASE_URL`/`AUTH_TOKEN` + model-alias envs, `:15-42`), injected at `session.ts:134,161-163`; availability = `isAvailable` env checks (`:101-106`); session pinned to provider in brain-ui's SQLite (`ws/handler.ts:175-192,316-333`).

## Deployment

Multi-stage Dockerfile (Ubuntu 24.04 runtime for glibc/Claude CLI; installs git, cron, sshd, supervisor, Chrome + emoji fonts, gh, Bun, Claude Code CLI, Gemini CLI; `IS_SANDBOX=1`). `docker-compose.prod.yml` is **Coolify-specific** (external `coolify` Traefik network, `/opt/brain-ui/*` bind mounts, SSH host port 2223). Host: Coolify 4.x on shared Hetzner VPS `91.99.200.114`, domain `brain.schlesser.net` (DNSimple), Coolify app UUID in CLAUDE.md:63. supervisord runs syslogd, sshd, cron, Bun server. In-app scheduler (`server/src/cron/scheduler.ts`) only serves manual triggers + run history.

**Auth: NONE except Tailscale IP allowlist** (`server/src/middleware/tailscale.ts`, CGNAT `100.64.0.0/10` or localhost), applied to `/api/*` + `/ws` in production (`app.ts:43-46`); frontend `/*` + `/api/health` public (PWA install). **Middleware trusts `x-forwarded-for` unconditionally — spoofable if the port is exposed without a trusted proxy.** Claude auth via `CLAUDE_CODE_OAUTH_TOKEN`.

Same-origin serving already exists in production (`app.ts:60-64` serves client/dist with SPA fallback; `getWsUrl()` falls back to window.location). `VITE_BACKEND_URL` build-time coupling (client/src/lib/backend.ts:12,15 — tailnet example in comments) exists only for Alain's split topology (public frontend, VPN backend).

## Personal data / secrets

- No live secrets in git; `.env` gitignored, `.env.example` placeholder-only (verified). **Working-tree `.env` contains a real DEEPGRAM_API_KEY — rotate.**
- Committed personal identifiers: name in `.env.example:32` (GIT_USER_NAME) + `Dockerfile:40` LABEL; `brain.schlesser.net` in `app.ts:32` (CORS) + `location/reverse-geocode.ts:25` (UA) + `backend.ts:4`; tailnet `coolify-1.wyvern-smoot.ts.net` in backend.ts comments; default repo `schlessera/brain.git` in `.env.example:29`, compose `:18`, `entrypoint.sh:22`; VPS IP/Coolify UUID in CLAUDE.md:58-67 + docs/DEPLOYMENT.md; name in tests (`brain-client.test.ts:120`, `claude-session.live.test.ts:194`).

Env vars: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, BRAIN_PATH, DB_PATH, PORT, HOST, NODE_ENV, GITHUB_TOKEN, BRAIN_REPO_URL, GIT_USER_NAME/EMAIL, TZ, DEEPGRAM_API_KEY, VOICE_KEYTERM_LIMIT, VOICE_CACHE_DIR, OPENROUTER_API_KEY, CEREBRAS_API_KEY, CEREBRAS_PROXY_URL, BRAIN_UI_REVERSE_GEOCODE, NOMINATIM_URL/USER_AGENT, CLAUDE_CODE_PATH, GEMINI_API_KEY (cron/whatsup), build-time VITE_BACKEND_URL.

## Health

No CI, no root README. 42 test files (`bun test`; unit/integration/e2e/live; live gated behind `BRAIN_UI_LIVE_TESTS=1`); good coverage of tailscale guard, stream-adapter, ws, migrations, walker, protocol, stores, risk-hints. 2 SQL migrations; brain-ui.db holds only session metadata + cron history (chat content lives in SDK JSONL).

## Open-source blockers (summary)

1. No generic auth path (Tailscale-only + spoofable header trust).
2. Hardcoded personal identifiers (domain, repo, name, tailnet, VPS docs).
3. Coolify-specific compose; no vendor-neutral deployment.
4. Build-time VITE_BACKEND_URL (fixed by same-origin default).
5. No CI/README; recommended live contract test missing.
6. Rotate working-tree Deepgram key.

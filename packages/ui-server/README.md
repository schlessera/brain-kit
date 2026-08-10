# @schlessera/brain-ui-server

The brain-kit chat-UI backend as a library: a Hono app factory that serves the
REST API, the authenticated WebSocket, and the agent turn coordinator. The
deployment shell owns the process — port, `Bun.serve()` wiring, SIGTERM, the
built client bundle, and the optional PNG/PDF renderer — and injects those
pieces through `createApp()`.

**Bun-only** (`bun:sqlite`, `hono/bun`). See `engines`.

## Usage

```ts
import { createApp, cancelActiveTurn, closeDb } from "@schlessera/brain-ui-server";

const app = createApp({
  staticRoot: "./client/dist",        // optional: serve a built SPA + fallback
  renderer,                           // optional: { renderPng, renderPdf }
  appName: "Brain UI",                // branding in status copy
  dbPath: process.env.DB_PATH,        // session/passkey SQLite (default ./brain-ui.db)
});

export default {
  port: 3000,
  fetch: app.fetch,
  websocket: app.websocket,
};
```

One app per process: `createApp()` configures a process-wide host (WebSocket
coordinator, SQLite handle, backend registry) — calling it twice with
different options reconfigures the first app rather than creating a second.

## What it owns

- **`createApp(options)`** — route mounting order, CORS (split topology via
  `ALLOWED_ORIGINS`), the auth guard, and the `/ws` upgrade (CSWSH origin check
  + cookie/IP auth). Refuses to boot on an unsafe auth configuration.
- **Auth** (`AUTH_MODE`): `password` (+ passkeys/WebAuthn), `tailscale`,
  `proxy`, `none` (loopback-only unless explicitly overridden).
- **WebSocket turn coordinator** — parallel sessions with per-session turn
  slots, follow-up queueing, host-owned per-turn timeout/cancellation, and the
  approval / ask-user / location round-trips. Decomposed into explicit host
  objects (`WsHost`, `TurnCoordinator`, `SessionCatalog`) under `src/ws/`.
- **Session catalog** — SQLite (WAL) with bundled migrations, applied on first
  open.
- **Brain routes** — search/briefing/stats/list/add plus SSE sync/whatsup,
  spawning the `brain` CLI from `BRAIN_PATH`.
- **Voice** — Deepgram token minting and keyterm-cache building from the brain
  index.
- **Render seam** — `POST /api/render` answers 501 unless the deployment
  injects a renderer (see `@schlessera/brain-render-puppeteer`).
- **Model catalog** — Anthropic model discovery (via
  `@schlessera/brain-backend-claude`) behind `GET /api/models`, with a
  server-side hidden set (`PUT /api/models/hidden`) and a manual
  `POST /api/models/refresh`. `/api/providers` serves the same roster minus the
  hidden entries; hidden profiles still resolve for sessions pinned to them.

## Environment

The package reads the same env contract the brain-ui deployment documents:
`AUTH_MODE`, `BRAIN_UI_PASSWORD_HASH`, `COOKIE_SECRET`, `TRUST_PROXY`,
`WEBAUTHN_*`, `BRAIN_PATH`, `DB_PATH`, `AGENT_BACKEND`,
`BRAIN_UI_CLAUDE_PROFILES`, `BRAIN_UI_MODEL_DISCOVERY`,
`BRAIN_UI_MODEL_TTL_HOURS`, `MAX_CONCURRENT_SESSIONS`, `DEEPGRAM_API_KEY`,
`VOICE_*`, `NOMINATIM_*`, `ALLOWED_ORIGINS`. `createApp()` options win over
env where both exist.

Model discovery is on by default and needs no configuration beyond the Claude
credential the agent already uses (`CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`). `BRAIN_UI_MODEL_DISCOVERY=0` turns it off — leaving the
picker to `BRAIN_UI_CLAUDE_PROFILES` alone — and `BRAIN_UI_MODEL_TTL_HOURS`
(default 24) sets how long a discovered roster is served before a background
refresh. It defaults to OFF under a test runner (`NODE_ENV=test`) so suites
don't depend on network access; set the var explicitly to opt in.

## Versioning

Versions in lockstep with all `@schlessera/brain-*` packages.

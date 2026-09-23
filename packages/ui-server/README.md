# @schlessera/brain-ui-server

The brain-kit chat-UI backend as a library: a Hono app factory that serves the
REST API, the authenticated WebSocket, and the agent turn coordinator. The
deployment shell owns the process — port, `Bun.serve()` wiring, SIGTERM, the
built client bundle, and the optional PNG/PDF renderer — and injects those
pieces through `createApp()`.

**Bun-only** (`bun:sqlite`, `hono/bun`). See `engines`.

## Usage

```ts
import { createApp, MAX_ARCHIVE_BYTES } from "@schlessera/brain-ui-server";
import { SHARE_MAX_TOTAL_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import { MAX_CLIENT_FRAME_BYTES } from "@schlessera/brain-ui-sdk/schemas";
import { renderPng, renderPdf, shutdownRenderer } from "./renderer.js";

const app = createApp({
  staticRoot: "./client/dist",        // optional: serve a built SPA + fallback
  renderer: { renderPng, renderPdf }, // optional
  appName: "Brain UI",                // branding in status copy
  // config: resolveServerConfig(env) // optional: explicit configuration;
  //                                  // omitted = resolved from process.env once
});

// Fail startup while it is still visible if a lazy backend cannot construct.
await app.wsHost.registry.getBackends();

// The brain-ui shell does not currently pre-start its Puppeteer browser. For
// deployments where first-render latency matters, this is a recommended
// optional warm-up probe before Bun.serve(); let a failure abort startup:
// await renderPng({ html: "<!doctype html><title>renderer warm-up</title>" });

const MULTIPART_HEADROOM_BYTES = 1_000_000;
Bun.serve({
  port: 3000,
  hostname: "0.0.0.0",
  // Leave multipart framing room above the largest upload accepted by any
  // route: currently skill archives (100 MiB), ahead of shares (50 MB).
  maxRequestBodySize:
    Math.max(MAX_ARCHIVE_BYTES, SHARE_MAX_TOTAL_BYTES) +
    MULTIPART_HEADROOM_BYTES,
  // SSE sync/whatsup streams may be quiet while nested processes work. This
  // is Bun's maximum idle timeout.
  idleTimeout: 255,
  fetch: app.fetch,
  websocket: {
    ...app.websocket,
    // Let the SDK parser normally produce the application-level frame error.
    maxPayloadLength: MAX_CLIENT_FRAME_BYTES + 64 * 1024,
  },
});

process.on("SIGTERM", async () => {
  const hadActiveTurns = app.cancelActiveTurns();
  if (hadActiveTurns) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await shutdownRenderer();
  app.close();
  process.exit(0);
});
```

The values and shutdown order above mirror the `brain-ui` deployment shell.
The only intentionally additional step is the commented renderer warm-up:
`brain-ui` has no browser pre-start today, so its first real render pays the
headless Chrome cold-start cost.

Apps are self-contained: each `createApp()` call builds its own WebSocket
coordinator, SQLite handle and backend registry from its (resolved or
injected) configuration, so two differently-configured apps coexist in one
process. The returned handle carries `config`, `db`, `wsHost`,
`isTurnActive()`, `cancelActiveTurns()` and `close()` for the deployment
shell's lifecycle wiring.

## Interactive search

Search has a 15-second deadline and returns HTTP 504 with a readable error on
expiry. The route propagates the incoming request's abort signal to its
read-only CLI subprocess, so a disconnected or superseded browser request stops
that work. Keep the original `Request` when forwarding to `app.fetch` in a
Bun deployment. Mutating commands retain their existing lifecycle.

## Cron bin

The package ships the Bun-only `brain-ui-cron` executable for the container
crontab. The deployment shell calls this bin instead of carrying loose cron
scripts:

```sh
brain-ui-cron run <job-name> -- <command...>
brain-ui-cron digest
brain-ui-cron crontab \
  [--wrapper-command <command>] \
  [--digest-command <command>] \
  [--path-line <line>] \
  [--user <user>]
brain-ui-cron environment
```

`run` spawns the command directly as argv (never through a shell), tees stdout
and stderr unchanged, records the run in `cron_runs` and the activity store,
and returns the command's exit code. Database tracking is fail-open: an
unavailable UI database produces a warning but does not suppress the job.

`digest` generates and persists the daily activity digest. Unlike run
tracking, digest generation fails loud with a non-zero exit because a stalled
covered-until marker would block normal activity-detail retention.

`crontab` writes a complete system crontab to stdout. It runs `brain module
list --json` from `BRAIN_PATH` (default `/data/brain`), re-validates every
module cron field before placing it in a system crontab line, and keeps the
legacy `scripts/jobs/scrape-all.ts` fallback when that file exists and no
enabled module exposes the `jobs` command. Its deployment parameters default
to the historical shell values:

| Flag | Default |
| --- | --- |
| `--wrapper-command` | `bun /opt/brain-ui/server/scripts/cron-run.ts` |
| `--digest-command` | `bun /opt/brain-ui/server/scripts/brain-digest.ts` |
| `--path-line` | `PATH=/root/.local/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` |
| `--user` | `root` |

For the packaged-bin cutover, pass the bin by absolute path because each job
first changes directory to `/data/brain`, whose own `node_modules` must not
decide which executable runs:

```sh
brain-ui-cron crontab \
  --wrapper-command "/opt/brain-ui/server/node_modules/.bin/brain-ui-cron run" \
  --digest-command "/opt/brain-ui/server/node_modules/.bin/brain-ui-cron digest" \
  --user root
```

`environment` writes `/etc/environment` content to stdout. Its fixed-order
allowlist comes from the SDK's `SUBPROCESS_ENV` `cron` audience. `NODE_ENV` is
the one explicit compatibility exclusion: scheduled jobs historically did not
receive it, so adding it would change Bun's `.env.<mode>` selection in the
brain repository.

## What it owns

- **`createApp(options)`** — route mounting order, CORS (split topology via
  `ALLOWED_ORIGINS`), the auth guard, and the `/ws` upgrade (CSWSH origin check
  + cookie/IP auth). Refuses to boot on an unsafe auth configuration.
- **Auth** (`AUTH_MODE`): `password` (+ passkeys/WebAuthn), `tailscale`,
  `proxy`, `none` (loopback-only unless explicitly overridden).
- **Principal access** (password mode only): `GET /api/auth/principals` lists
  active devices and agents, `POST /api/auth/principals` mints an agent
  credential, and `DELETE /api/auth/principals/:id` revokes one. These routes
  are disabled in every other `AUTH_MODE`.
- **WebSocket turn coordinator** — parallel sessions with per-session turn
  slots, follow-up queueing, host-owned per-turn timeout/cancellation, and the
  approval / ask-user / location round-trips. Decomposed into explicit host
  objects (`WsHost`, `TurnCoordinator`, `SessionCatalog`) under `src/ws/`.
- **Session catalog** — SQLite (WAL) with bundled migrations, applied on first
  open.
- **Brain routes** — search/briefing/stats/list/add plus SSE sync/whatsup,
  spawning the `brain` CLI from `BRAIN_PATH`.
- **Activity routes** (`/api/activity/*`, behind the auth guard) — the run
  list and drill-in, per-day/job/session rollups, the digest, the inbox, and
  `GET /api/activity/stats?days=N`: the runtime half of a stats page —
  lifetime session figures, a windowed rollup summary labelled with the days
  it covers and where detail pruning starts, and the server database's size.
  `GET /api/brain/stats` stays the corpus half; the two are merged by the
  caller. Shape: `ActivityRuntimeStats` in `@schlessera/brain-ui-sdk/protocol`,
  documented in [docs/integration-contract.md](../../docs/integration-contract.md).
- **Voice** — Deepgram token minting and keyterm-cache building from the brain
  index.
- **Render seam** — `POST /api/render` answers 501 unless the deployment
  injects a renderer (see `@schlessera/brain-render-puppeteer`).
- **Model catalog** — Anthropic model discovery (via
  `@schlessera/brain-backend-claude`) behind `GET /api/models`, with a
  server-side hidden set (`PUT /api/models/hidden`) and a manual
  `POST /api/models/refresh`. `/api/providers` serves the same roster minus the
  hidden entries; hidden profiles still resolve for sessions pinned to them.
- **Backend registry** — iterates `BackendModule` descriptors
  (`@schlessera/brain-ui-sdk/server`) rather than knowing any backend by name.
  Each backend owns its own profile parsing, billing rule, settings hooks and
  optional model source. `AGENT_BACKEND` selects among the FIRST-PARTY ids only
  (`claude`, `pi`) — it is not a package specifier, and there is no runtime
  discovery. A third-party backend is imported and passed by value:
  `createApp({ registry: createStaticBackendRegistry({ ... }) })`, which keeps
  the descriptor's hooks and model source. See
  [docs/extending/agent-backends.md](../../docs/extending/agent-backends.md).
  A session whose stored `backend_id` names a backend this deployment does not
  have fails explicitly instead of silently running on the default.

## Environment

Every variable this package reads, and what happens when it is unset.
`createApp()` configuration wins over the environment where both exist.

<!-- env:begin -->

| Variable | What it controls | Unset |
| --- | --- | --- |
| `AGENT_BACKEND` | Primary agent backend: "claude" (default) or "pi". | claude |
| `ALLOWED_ORIGINS` | Comma-separated cross-origin allowlist for a split client/API topology; empty means same-origin only. | (empty) |
| `ANTHROPIC_API_KEY` | Consulted for PRESENCE only, to classify billing: when set it wins over CLAUDE_CODE_OAUTH_TOKEN (mirroring the Agent SDK's credential precedence), so ambient-credential profiles count as api-billed. | — |
| `AUTH_MODE` | Authentication mode: password \| tailscale \| proxy \| none. Unset auto-detects (password when a hash is set, else tailscale). | (auto-detect) |
| `BRAIN_PATH` | Path to the brain repo the server operates on. | $HOME/brain |
| `BRAIN_UI_ALLOW_LOOPBACK_ORIGIN` | Set "1" to accept loopback Origins for WebAuthn regardless of Host (dev-only, for the vite proxy). | 0 |
| `BRAIN_UI_ALLOW_PASSWORD` | Set "1" to keep password login enabled after a passkey exists for the RP (break-glass recovery). | 0 |
| `BRAIN_UI_CLAUDE_DEFAULT_MODEL` | Model the built-in default Claude profile is pinned to. | claude-opus-5-5 |
| `BRAIN_UI_CLAUDE_PROFILES` | JSON array of extra Anthropic-compatible inference profiles ({id,label,model?,baseUrl?,authTokenEnv?,apiKeyEnv?,modelAliases?}). | (none) |
| `BRAIN_UI_COASTLINE` | "0"/"off"/"false" stops the server fetching map geometry. Maps then draw their graticule, pins and scale bar with no coastline, which is still an accurate locator. | enabled |
| `BRAIN_UI_CONFIRM_BASH` | JSON array of regex sources, or {"pattern", "effect"} objects whose effect (what the command does, in words) is shown on the card; a Bash command matching any of them raises a confirmation card before it runs. Unset uses the shipped defaults (brain archive, rm -r, git push --force, git reset --hard, git clean -f, git checkout -- ). An empty array [] disables the confirmation. Not a security boundary — an agent with Bash can reach the same effect another way; it stops a destructive command you did not intend, not one that is trying to get past you. | the shipped pattern set |
| `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH` | Set "1" to allow AUTH_MODE=none on a non-loopback host. Every network peer gets full agent access. | 0 |
| `BRAIN_UI_EXEC_KILLER` | Absolute path to an authorised helper that cancels a wrapped process group, invoked as `<killer> <pgid> <TERM\|KILL\|INT>`. Needed only when the wrapper changes uid: signalling then fails with EPERM however the group is arranged, and an aborted request would keep running. | (none — signal the group directly) |
| `BRAIN_UI_EXEC_WRAPPER` | Absolute path to an executable every agent and brain-CLI subprocess is launched through, as `<wrapper> <program> <args…>`. Lets a host run those children as another user without this package knowing how. It is an argv[0], never a command line: no shell parses it. Unset, spawns are exactly what they were. | (none — spawn the program directly) |
| `BRAIN_UI_LOG_LEVEL` | Minimum severity the console log consumer emits: TRACE, DEBUG, INFO, WARN, ERROR or FATAL. Case-insensitive; an unrecognised value falls back to the default rather than silencing the server. | INFO |
| `BRAIN_UI_MODEL_DISCOVERY` | Model discovery against the Anthropic Models API; "0"/"off"/"false" disables. Defaults ON, except under a test runner (NODE_ENV=test) where it defaults OFF. | on (off under NODE_ENV=test) |
| `BRAIN_UI_MODEL_TTL_HOURS` | How long a model-discovery result stays fresh, in hours. | 24 |
| `BRAIN_UI_PASSWORD_HASH` | Bun.password argon2id hash of the shared password. | **required** — AUTH_MODE=password |
| `BRAIN_UI_PI_PROFILES` | JSON array of pi-backend model profiles ({id,label,vendor,model,thinkingLevel?}). When set (and AGENT_BACKEND is claude), the pi backend runs ALONGSIDE the Claude backend and these profiles join the picker — e.g. OpenAI models under a ChatGPT subscription via vendor "openai-codex". | (none) |
| `BRAIN_UI_PRICING_DISCOVERY` | Remote model-pricing refresh (LiteLLM + OpenRouter catalogs); "0"/"off"/"false" disables, and runs then roll up with unknown effective cost. Defaults ON, except under a test runner (NODE_ENV=test) where it defaults OFF. | on (off under NODE_ENV=test) |
| `BRAIN_UI_PRICING_TTL_HOURS` | How long a fetched model-pricing table stays fresh, in hours. | 24 |
| `BRAIN_UI_SKILLS_GITHUB_TOKEN` | GitHub token used when installing skills from a private repository (Settings → Skills) — typically read-only Contents on the skill repos. Falls back to GITHUB_TOKEN. | $GITHUB_TOKEN |
| `BRAIN_UI_SUBPROCESS_ENV_EXTRA` | Comma-separated environment variable names to admit to every child audience when an operator integration needs a variable outside the shipped allowlist. Names are trimmed; malformed entries are ignored; the control variable itself is never forwarded. | (empty) |
| `BRAIN_UI_TURN_TIMEOUT_MS` | Hard per-turn timeout in ms; the host aborts a turn that runs past it. Raise for agent-heavy research work (e.g. 1800000 for 30 minutes). | 600000 (10 minutes) |
| `BRAIN_UI_WS_BURST` | Inbound WebSocket frames absorbable in one burst before the sustained rate applies. Opening the app legitimately fires several at once. | 60 |
| `BRAIN_UI_WS_MAX_CONNECTIONS` | Maximum number of WebSocket connections accepted by one server process. | 32 |
| `BRAIN_UI_WS_RATE` | Sustained inbound WebSocket frames per second per connection. 0 disables metering entirely. | 20 |
| `CLAUDE_CODE_OAUTH_TOKEN` | Consulted for PRESENCE only, to classify billing: with it set and no ANTHROPIC_API_KEY, ambient-credential Claude profiles (the built-in default and discovered models) count as subscription-billed. The token itself is consumed by the Claude backend / Agent SDK, not this package. | — |
| `CLAUDE_CODE_PATH` | Path to the Claude Code native binary handed to the Agent SDK. | /usr/local/bin/claude |
| `COASTLINE_CACHE_DIR` | Directory holding fetched map geometry. Cached forever; coastlines do not move. | $BRAIN_PATH/.brain-ui/geo |
| `COOKIE_SECRET` | Secret signing the session cookie. | **required** — AUTH_MODE=password |
| `DB_PATH` | SQLite file for the UI's own database (sessions, passkeys, settings). The server factory defaults to ./brain-ui.db; brain-ui-cron defaults to the container path /data/db/brain-ui.db. | ./brain-ui.db (server); /data/db/brain-ui.db (brain-ui-cron) |
| `DEEPGRAM_API_KEY` | Deepgram API key for streaming ASR (short-lived tokens are minted from it). | **required** — VOICE_PROVIDER=deepgram (or any voice use without VOICE_PROVIDER=webspeech) |
| `GITHUB_TOKEN` | Generic GitHub token fallback. Used for skill installs when BRAIN_UI_SKILLS_GITHUB_TOKEN is unset; the deployment shell also falls back to it (from BRAIN_UI_SYNC_GITHUB_TOKEN) for brain-repo git pushes and gh-based jobs. | — |
| `HOME` | Fallback anchor for the BRAIN_PATH default and the pi config dir (~/.pi). | /root |
| `HOST` | Bind host; consulted by the auth validation to decide whether AUTH_MODE=none is loopback-safe. | (empty) |
| `MAX_CONCURRENT_SESSIONS` | Cap on concurrently RUNNING agent sessions. | 3 |
| `NODE_ENV` | Only consulted for test-runner detection: flips the model-discovery and pricing-discovery defaults to off under bun test. Never gates any security behavior. | (unset) |
| `OVERPASS_URL` | Overpass endpoint the map geometry is fetched from. | https://overpass-api.de/api/interpreter |
| `OVERPASS_USER_AGENT` | Identifying User-Agent for Overpass (usage-policy requirement). | brain-kit-ui/1.0 |
| `PI_CODING_AGENT_DIR` | pi config dir override — where the web-search settings write the pi-web-access extension's web-search.json (same precedence the extension itself uses). | $XDG_CONFIG_HOME/pi, else $HOME/.pi |
| `PROXY_AUTH_HEADER` | Header a fronting auth proxy sets for AUTH_MODE=proxy. | x-forwarded-user |
| `SOURCE_COMMIT` | Git SHA reported by /api/status (baked at image build time). | dev |
| `TRUST_PROXY` | Set "1" to trust x-forwarded-for/x-real-ip and the proxy auth header; only safe behind a trusted reverse proxy. | **required** — AUTH_MODE=proxy |
| `TRUST_PROXY_HOPS` | How many trusted proxies front the app (x-forwarded-for parse depth). | 1 |
| `TYPESAFE_API_KEY` | TypeSafe AI key for the classification pass that draws markdown the model typed as kit blocks (D42). Absent = pass disabled; the answer renders as markdown either way. | — |
| `VOICE_CACHE_DIR` | Directory holding the keyterm cache JSON. | $BRAIN_PATH/.brain-ui |
| `VOICE_KEYTERM_LIMIT` | Maximum custom-vocabulary terms built from the brain database. | 500 |
| `VOICE_PROVIDER` | Speech provider: "deepgram" or "webspeech" (opt-in only — Chromium streams audio to Google). Unset auto-detects deepgram when its key is present. | (auto-detect) |
| `WEBAUTHN_ORIGINS` | Comma-separated extra origins allowed for WebAuthn ceremonies. | (empty) |
| `WEBAUTHN_RP_ID` | Relying-party id override for proxies that rewrite Host. | (derived from the request origin) |
| `WEBAUTHN_RP_NAME` | Relying-party display name shown by authenticators. | Brain UI |
| `WEBAUTHN_USER_ID` | Stable WebAuthn user handle (wire contract — burned into every resident credential; max 64 bytes; never change it after the first passkey). | brain-ui-owner |
| `WEBAUTHN_USER_NAME` | WebAuthn user name shown by authenticators. | owner |
| `XDG_CONFIG_HOME` | Second-precedence anchor for the pi config dir ($XDG_CONFIG_HOME/pi). | — |

Generated from `packages/ui-server/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->

Model discovery is on by default and needs no configuration beyond the Claude
credential the agent already uses (`CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`). `BRAIN_UI_MODEL_DISCOVERY=0` turns it off — leaving the
picker to `BRAIN_UI_CLAUDE_PROFILES` alone — and `BRAIN_UI_MODEL_TTL_HOURS`
(default 24) sets how long a discovered roster is served before a background
refresh. It defaults to OFF under a test runner (`NODE_ENV=test`) so suites
don't depend on network access; set the var explicitly to opt in.


### The classification pass

With `TYPESAFE_API_KEY` set, the server runs one classification pass over
each finished turn's assistant text (D42): a deterministic walk finds the
markdown constructs that might be one of the kit's answer blocks, and a
single call to TypeSafe AI's Jev decides which shape each one is. The result
rides one additive `message_blocks` frame after the turn's `result`, and is
persisted per text part so history replays the same blocks without a second
call.

The pass is progressive enhancement and nothing else. The whole call, one
retry on 429/529 included, runs inside a 2 s budget; a timeout, an error, a
missing key, or an answer below the confidence threshold all mean the
markdown stays exactly as it streamed. No turn waits on the pass and no
answer can render worse for it having been asked. Outcomes are counted
(`classification.passes` by outcome, `classification.latency_ms`) so a slow
or failing classifier shows up in the server's record, not in the reader's
experience. A classifier that keeps failing is not asked: after three
consecutive failures (timeouts, rate limits, errors, malformed answers) a
breaker opens and every pass is skipped without a call for 30 s; each
failed probe after that doubles the wait, up to 30 minutes; one answered
probe closes it and resets the backoff. Openings and closings are logged.

## Versioning

Versions in lockstep with all `@schlessera/brain-*` packages.

### Capture recovery and concurrent requests

`POST /api/brain/add` preserves the CLI capture outcome alongside `success`:
`action`, `path`, `title`, `type`, `indexed`, and optional `indexError`.
A saved file with `indexed: false` is a partial success; retry indexing with
`POST /api/brain/index` (JSON media type) instead of submitting the content
again. Concurrent index retries share one run.

WebSocket session starts reserve their session id before backend routing.
Messages received during routing join the bounded follow-up queue; cancellation
before routing completes drops that queue and prevents the backend from starting.
New-conversation frames retain the client's `draftId` for reply correlation.

Wikilink scans visit each canonical directory once, including when directories
have symlink aliases or cycles. Concurrent refresh requests share a rebuild.

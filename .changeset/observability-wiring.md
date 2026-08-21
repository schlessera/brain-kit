---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Finish wiring the observability layer through the server: report what already failed silently.

The layer itself was sound — OpenTelemetry API on the producing side, our own
console/recording/in-memory consumers on the other — but adoption stopped at
two instruments, so most failures still answered the browser and left no
server-side trace.

- Turn lifecycle: every turn now emits "turn started" / "turn completed"
  (INFO, with `session.id` / `turn.id` / `profile` and duration), and every
  turn-failure path that previously only sent an error frame — SESSION_BUSY,
  BACKEND_REQUEST_ERROR, BACKEND_ERROR, FOLLOWUP_FAILED, SESSION_LOAD_ERROR —
  also logs (WARN for busy, ERROR otherwise) and feeds a `turns.failed`
  counter keyed by the bounded error code. `turns.started` / `turns.completed`
  counters and the turn-timeout WARN's correlation ids come with it.
- Auth: password logins are observable — WARN on a failed password and on the
  rate limit, INFO on success, and a distinct ERROR when `Bun.password.verify`
  throws (a corrupt BRAIN_UI_PASSWORD_HASH is no longer reported as a wrong
  password). Failures land on the same `auth.failures` counter passkeys use.
- Request logging now runs through the observability layer (method, path,
  status, duration; no query strings or bodies) instead of hono's raw-console
  `logger()`, so BRAIN_UI_LOG_LEVEL governs it; `/api/health` is skipped.
- `/api/health` performs a SELECT 1 liveness probe of the app database and
  answers 503 `{"status":"unhealthy"}` when it fails — the Docker healthcheck
  no longer reports healthy over a wedged SQLite handle.
- The dead `log?` seams (graph/files/share/render/models routes, settings,
  keyterm builder, share staging, the backend registry) actually receive a
  logger from `createApp`, and session-catalog write failures WARN with the
  session id instead of being swallowed.
- New `recordCronRun(db, jobName)` export lets an external scheduler (the
  container crontab in the shipped deployment) record runs into `cron_runs`,
  so `/api/status`'s `cronJobs` reflects what actually ran.
- WebSocket: the upgrade handlers gained `onError` (WARN + `ws.errors`
  counter), and broadcast send failures count on `ws.frames.dropped` with
  reason `broadcast_send_failed`, direction `outbound`.
- Backends take an optional minimal `log` callback (no OTel dependency):
  the Claude backend routes its unparseable-confirmBashPatterns warning
  through it (console.warn only when standalone), and the pi backend's
  resource-loader fallback — which silently dropped the chat-surface
  system-prompt append — now says so.

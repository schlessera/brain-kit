---
"@schlessera/brain-ui-server": minor
---

Add swappable observability consumers, and instrument the WebSocket frame path.

The producing side is the standard OpenTelemetry API — `logger.emit()`,
`counter.add()` — so instrumentation is written once and stays portable. The
consuming side is ours: a console consumer for production, a recording
consumer for tests, an in-memory meter that `/api/status` reads. Choosing where
reports go is an argument, never a change to instrumentation.

`createApp({ observability })` and `new WsHost({ observability })` take one by
injection, defaulting to the console consumer (WsHost defaults to silence, so
an embedder gets no surprise stream on stdout). Nothing requires the
OpenTelemetry globals; `installGlobally()` exists for code that cannot be
handed an argument and returns a restore function, so a test cannot strand a
sink for the next one. Two apps in one process report separately.

`createRecordingObservability()` is the test surface: `logs.find({ scope,
severity, body, attributes })`, `metrics.value(name, attributes)`,
`metrics.total(name)`, `metrics.snapshot()`. It is the same in-memory meter
production uses, so an assertion is about the real recorder rather than a
double. `createWsHandlers(host)` was split out of `createWsUpgrade` so a test
drives the actual frame path without an HTTP server.

Three holes are now instrumented. A `parseClientMessage` rejection was answered
to the client and never logged — the inbound validation already shipped had no
observability at all. A handler that threw sent `INTERNAL_ERROR` and discarded
the cause. Both now emit, and dropped frames land on a `ws.frames.dropped`
counter split by reason, exposed on `/api/status` next to `cronJobs`. Reported
detail is always a bounded token, never the frame body, which is
caller-supplied and capped at 12 MB.

`@opentelemetry/api` is caretted (stable 1.x, zero dependencies).
`@opentelemetry/api-logs` is pinned EXACT: the logs API is 0.x. That was
measured rather than assumed — the producing surface is unchanged across
0.57 → 0.221 and the global handshake is keyed on a compatibility constant that
has stayed at 1, so mixed copies interoperate. The churn is in
`@opentelemetry/sdk-logs`, which is precisely the package these consumers
replace and which is not a dependency.

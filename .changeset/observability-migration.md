---
"@schlessera/brain-ui-server": minor
---

Report through the observability layer instead of `console`, and make the
threshold configurable.

All 31 `console.*` sites in this package now emit through the injected
`Observability`: structured, severity-filtered, assertable in a test, and
routable somewhere else later without touching a call site. A test enforces
it — AST-based, so the shell command inside an auth error message that
contains the literal text `console.log` does not trip it. The console consumer
itself is the one exemption, and the test asserts that exemption is still real
so the list cannot rot.

`BRAIN_UI_LOG_LEVEL` (default `INFO`) sets the console consumer's threshold. An
unrecognised value falls back rather than throwing: a typo in a log level must
not be why a server refuses to boot, and silently emitting nothing would be
worse than emitting too much. The two security-critical boot messages —
unknown `AUTH_MODE`, and `AUTH_MODE=none` deliberately permitted on a
non-loopback host — emit at ERROR so a log threshold can never be the reason
nobody saw them.

Failed passkey ceremonies now increment an `auth.failures` counter split by
reason and ceremony, alongside the log. A rate of those is what distinguishes
one fumbled login from someone working through a list, and it was not
recoverable from a log line nobody tails.

Observability is constructed first in `createApp` — before the auth validation
that can refuse to boot and before the migration runner — so nothing that can
report is built before somewhere to report exists.

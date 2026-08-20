---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Meter inbound WebSocket frames, and make `turnId` enforceable via a rev-3
handshake.

**Rate limiting.** Frames were size-, cardinality- and depth-bounded but not
metered, so a flood of individually valid frames was unbounded behind the auth
guard. Each connection now gets a token bucket — `BRAIN_UI_WS_RATE` (default 20
frames/sec) and `BRAIN_UI_WS_BURST` (default 60), with `0` disabling it. A
bucket rather than a fixed window because the real traffic is bursty: opening
the app fires several frames at once and an approval storm is a dozen in a
second, both legitimate. The bucket lives on the socket, not in a map keyed by
something a peer controls — that map is itself the memory-exhaustion bug a rate
limiter is supposed to prevent. Metering runs BEFORE parsing, since parsing is
most of the work being bounded, and refusals land on the existing
`ws.frames.dropped` counter under `reason: rate_limited`.

**Protocol rev 3.** `turnId` could not be made mandatory because there was no
client→server handshake: a host could not tell a current client from a
two-year-old one, so enforcing would have broken every tool approval in older
UIs. `client_hello` fixes that — a client declares its revision, and a host
applies rev-3 rules only to connections that declared rev 3. Clients that send
no hello are treated as rev 2 and keep today's tolerance indefinitely. This is
therefore additive: no existing client changes behaviour.

**A bug in the previous release's turnId echo is fixed here.** `BrainUiClient`
tracked "the most recent turn id seen", which is correct with one session and
wrong with two: a delta from session B arriving between session A's approval
request and the user answering it made the reply carry B's id, the host refused
the mismatch, and A's turn waited for an approval that could never be accepted
— invisible until the ten-minute timeout. Turn ids are now tracked per request
id and consumed when the reply goes out.

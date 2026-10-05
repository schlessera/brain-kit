---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Notify recipients about waiting Actions. Push-eligible decisions (score 12 or
more) collect in a fixed 60-second window per recipient and leave as one
counted notice that opens Actions. Each device is evaluated on its own:
strict local quiet hours from 22:00 to 08:00, at most one known successful
push per waiting episode, and bounded retries that resend only what is still
waiting and unsent. Lower-priority decisions and FYIs join the in-app digest
at the client's local 09:00 and 17:00, listing only work not already reported
to that client. Clients report their IANA zone on registration, rebind,
reconnection, foreground return and zone change; without a usable zone,
timed notices stay pending instead of using server time. Additive: optional
`timeZone` on `POST /api/push/subscribe`, `timeZone` in subscription
summaries, the SDK worker renewal sends its zone, and the
`ActionDigestEntry`/`ActionDigestSummary`/`ActionDigestState` protocol types.

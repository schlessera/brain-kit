---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

A tainted interactive session now asks before reaching a new destination instead of refusing it silently (#3430). When a governed or strict turn behind the egress proxy connects to a host outside its `taint.egress.allow` list and the hosts the session already contacted, the user sees a `Network` permission card naming the host, what tainted the session, and that allowing it admits the host for the rest of the session. Allowing admits the connection and every later one to that host in the session; declining refuses it with a 403 whose status text and body tell the tool the user declined. Voice turns still refuse without a card, autonomous turns are unchanged, and `deny` and `allowlist` egress modes still refuse first. `startEgressProxy`'s `taint` option gains an optional `approve` callback.

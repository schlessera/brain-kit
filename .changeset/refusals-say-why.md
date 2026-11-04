---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": patch
"@schlessera/brain-module-images": patch
---

A refused network request now says why, so the agent stops blaming the remote service or the user's account (#3431). The turn egress proxy answers every refusal with a policy cause with a status text and body naming it: a tainted session's host outside its allow-list (with what tainted the session and what the user can do), the egress deny or allow list, the turn's byte limit, or an unapproved outward host. `curl -v`, `git` and HTTP clients show the reason. A relayed provider request that the proxy refuses reports the cause in its error message and in a new `error.reason` field. `brain image` shows that message without the OpenAI "region not supported, or the org is not verified" hint, which still appears for a genuine OpenAI 403. The system prompt gains a line naming these causes. `startEgressProxy`'s `taint` option gains an optional `cause` callback.

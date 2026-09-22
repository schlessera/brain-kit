---
"@schlessera/brain-ui-server": patch
---

A refused "always allow" now leaves a record. The host already logged a
remembered grant it declined to apply to a turn whose enforced allowlist left
the tool out; the other direction — the user pressing "Always allow" on such a
card and the host declining to keep it — was silent, which is the half somebody
actually notices, because they pressed the button. It is logged with the tool
and the reason, including for a per-use `command` confirmation, where an
`always` arriving on the wire also says a client sent an option its own UI does
not offer. The decisions themselves are unchanged: the call the user approved
still runs, and nothing new is remembered.

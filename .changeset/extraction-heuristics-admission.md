---
"@schlessera/brain-common": minor
"@schlessera/brain": minor
"@schlessera/brain-ui-server": minor
---

Add the `taint.classifier` governance policy setting, `off` by default. With `heuristics`, the host judges each outgoing call of a tainted session at admission with the deterministic extraction heuristics measured in #3434: a call that copies a file the session read to a new or writing destination is refused with the reason as its tool result, a suspicious call asks with the reason on a per-use card (even to a host the session already reached), and a clean read admits the hosts it names without the tainted-destination card while it runs. Deny, `allowlist` mode, budgets, outward cards and voice refusals are unchanged. `brain policy check` reports the resolved setting.

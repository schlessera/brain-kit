---
"@schlessera/brain-ui-server": minor
---

Prepare bounded immutable Git-object reads for managed reference source. The
host's offline, credential-free transport returns an exact byte range with
blob identity, mode and SHA-256 evidence after checking the full object hash.
Literal paths, regular-blob modes, size limits and cancellation are enforced.
Actual backend read delivery, durable read correlation and repository trust
remain separate requirements.

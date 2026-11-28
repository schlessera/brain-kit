---
"@schlessera/brain-ui-server": patch
---

A changed trust policy no longer waits behind automatic indexing. The durable trust projection now has its own lock apart from the brain document lock, so a turn that starts after an out-of-band `trusted_sources` edit projects the new rules and is admitted while an index holds the brain lock. Settings publications keep their serialization: a Settings commit holds the trust projection lock from its base check through its own projection.

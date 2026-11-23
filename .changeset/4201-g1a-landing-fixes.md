---
"@schlessera/brain-common": patch
"@schlessera/brain-ui-server": patch
---

Google foundation fixes from the landing review (#4201). A gog pin check that throws, for example on a failed read of the binary, is now the transient refusal `verification_failed`: the transport checks again after its backoff instead of answering the same failure until a restart, and no exception text reaches the answer. `GOG_PIN_TRANSIENT_REFUSALS` is exported from `@schlessera/brain-common/internal/google-gog`. The host's Google status says such a refusal is checked again shortly rather than calling the binary an unaccepted release, and its `not_connected` detail no longer names a `brain google` command this release does not ship.

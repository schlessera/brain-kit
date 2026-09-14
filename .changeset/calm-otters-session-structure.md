---
"@schlessera/brain-ui-server": minor
---

Rename the public `hasValidSession` resolver to `resolveCookiePrincipal`, and replace the legacy `bumpSessionsEpoch` export with the durable `revokeAllSessions` primitive.

Derive principal kinds in the store, reject non-cookie principals during cookie authentication, tolerate stale ambient labels and corrupt downgrade epochs, and close the passkey deletion race inside principal creation.

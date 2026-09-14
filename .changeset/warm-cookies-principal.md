---
"@schlessera/brain-ui-server": minor
---

Export `resolveCookiePrincipal` with its resolved `Principal`, replace epoch
session cookies with signed principal ids, and replace `bumpSessionsEpoch` with
the durable `revokeAllSessions` primitive.

Require an owner principal for passkey management, limit agent logout to its
own principal, and expire live WebSocket authorization through the complete
revocation boundary.

Rename route revocation dependencies from `clients` to `revoker`, remove the
partial `ClientSet.revokePrincipals` method, and add `expiresAt` to
`AuthorizationContext`.

Derive principal kinds in the store, reject non-cookie principals during cookie
authentication, tolerate stale ambient labels, close the passkey deletion race
inside principal creation, and move the rollback guard into the upgrade
migration.

---
"@schlessera/brain-ui-server": minor
---

Document principal routes and the operator procedure for agent credentials,
revocation, and cookie-format transitions. The public `isWsAuthorized` helper
now returns a resolved `Principal` or null, and `revokeAllSessions` replaces the
removed `bumpSessionsEpoch` export.

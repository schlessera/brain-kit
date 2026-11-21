---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-common": minor
---

Add Security settings for exact origin and opaque tunnel source trust and separate data-sending permission, using protected exact-byte owner review. Show repository scopes as disabled/unverified until enforcement is available. Authenticated callers can read sanitized trust facts without gaining mutation authority; older hosts remain read-only.

Recheck live read authority after waits, discard private reviews on owner loss, recover expired prepared reviews, and prevent refreshed drafts from restoring revoked permissions or removing replacement rules.

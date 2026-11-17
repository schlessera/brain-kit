---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

Apify gets one owner section in Settings › Accounts › External services: the provider and charged account, Catalog search and Running Actors modes, approved Actors, the effective limits and today's spend, inline on desktop and a drill-in on phones. Every control proposes the change through the existing policy-change review and changes nothing until the owner approves that exact diff; a lost answer is reconciled, never resent. The Actor run approval shows the exact Actor, build, profile, what is sent where, the charged account, the cap and anything not covered, with Allow once and Deny only. Apify spend appears beside inference in turn cost details and in Activity, as an upper bound until settled and as unknown rather than $0 when it cannot be read; after a local Stop an unconfirmed remote abort stays visible until the host settles it. Internal `GET /api/apify` adds `policy` and `spend`, and two owner routes, `POST /api/apify/policy` and `POST /api/apify/policy/:turnId/:requestId`, carry the edits.

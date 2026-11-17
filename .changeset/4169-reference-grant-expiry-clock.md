---
"@schlessera/brain-ui-server": patch
---

Creating a reference grant now refuses a target or creating owner login that expires while the request waits for the write worker (#4169). The route stamps the request's time before that wait, and the expiry check inside the writer transaction compared against that stamp, so a login that expired meanwhile still passed. The check now reads the clock inside the transaction and refuses as `Unknown principal` (404). The stamped time still records the grant's `created_at` and drives retention of revoked grants. Revoking a grant is unchanged: its time only records `revoked_at`.

---
"@schlessera/brain-ui-react": minor
---

Standing Gmail permissions can be seen and taken back where they apply (#4212). Settings › Security lists remembered Gmail approvals ("Allow always") under each account, beside the always-allowed tools, each with a Revoke. A restricted chat lists its Gmail allowances inside its safety notice, one row per granting card with the changes left and when it ends, each revoked by that card. Both lists read and revoke through the owner-only routes.

Each list appears once its first read finds something to manage or fails, so a brain without Gmail shows neither. A 503 shows the list's unavailable state, and a 401 or 403 hides it, on a read or a revoke alike; a 404 hides it too. Any other failure shows the failed state with Try again, including a successful answer that is not the route's envelope. Rows the client cannot name are counted, never called none. A revoke answered `revoked: false`, or one that failed some other way, is followed by a fresh read, and a failed one keeps its error. A chat revoke is always followed by a fresh read. The chat list also reads again when a Gmail modify or draft call in that chat returns its result, just after the earliest end it shows, and when the page becomes visible. Label actions show the label's id, because the routes carry no label names.

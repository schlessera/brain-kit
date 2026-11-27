---
"@schlessera/brain-ui-react": minor
---

Standing Gmail permissions can be seen and taken back where they apply (#4212). Settings › Security lists remembered Gmail approvals ("Allow always") under each account, beside the always-allowed tools, each with a Revoke. A restricted chat lists its Gmail allowances inside its safety notice, one row per granting card with the changes left and when it ends, each revoked by that card. Both lists read and revoke through the owner-only routes.

Each list appears once its first read finds something to manage or fails, so a brain without Gmail shows neither. A read answered 503 shows the list's unavailable state; a 401, 403 or 404 hides it. Any other failed read, including a successful answer that is not the route's envelope, shows the failed state with Try again. Rows the client cannot name are counted, never called none.

A revoke answered 503, 401, 403 or 404 changes the list the same way, reads nothing more, and no read sent before that answer can undo it. A successful revoke is followed by a fresh read, except a Settings revoke answered `revoked: true`, which drops the row there. A revoke that failed any other way may still have happened, so it keeps its error banner and is followed by a fresh read; the banner stays over whatever that read finds, unless the read hides the list.

The chat list also reads again when a Gmail modify or draft call in that chat returns its result, just after the earliest end still ahead among the cards it shows, and when the page becomes visible. A card whose end has already passed by this device's clock stays shown, because the host decides which cards are live; one more read follows just after such an answer, once for each end, and an end on an earlier day shows its date. Label actions show the label's id, because the routes carry no label names.

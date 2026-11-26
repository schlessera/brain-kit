---
"@schlessera/brain-ui-react": minor
---

Standing Gmail permissions can be seen and taken back where they apply (#4212). Settings › Security lists remembered Gmail approvals ("Allow always") under each account, beside the always-allowed tools, with a Revoke on each. A restricted chat lists its Gmail allowances inside its safety notice, one row per granting card with the changes left and when it ends, each revocable by that card. Both read and revoke through the owner-only routes. Each list appears only once there is something in it, so a brain without Gmail shows neither. A 503 shows the list's unavailable state; 401, 403 and 404 hide it. Every chat revoke is followed by a fresh read. Label actions show the label's id, because the routes carry no label names.

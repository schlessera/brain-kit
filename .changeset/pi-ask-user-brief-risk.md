---
"@schlessera/brain-backend-pi": patch
---

A new pi session's system brief now tells the model to call `ask_user` for a tappable choice (#2800). It named `inbox_list`, because the name was taken from the first entry of the bridge tool list, and the inbox tools were later added ahead of `ask_user`. An existing session keeps the brief it started with, byte for byte, so its provider cache is not broken. Start a new session to get the corrected wording.

`TOOL_RISK` in `@schlessera/brain-backend-pi/internal` now classifies `turn_temp` as `read` and `propose_policy_change` as `mutate` (#2801). Nothing at runtime reads the table, so approvals and locks do not change.

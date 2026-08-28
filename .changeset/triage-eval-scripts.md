---
"@schlessera/brain-ui-server": patch
---

Add `eval:triage` and `eval:triage:validate` scripts for the background-triage
model gate.

The eval itself lives in `evals/` and is not published — it is excluded from the
package's `files` list, sits outside the test glob, and refuses to run without
`BRAIN_UI_LIVE_EVALS=1` because it calls paid provider APIs. Only the two script
entries are user-visible.

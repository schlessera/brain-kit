---
"@schlessera/brain-ui-server": minor
---

A governed turn's `files_changed` scope limit no longer counts changed paths under `workspaces/` (#3793). Fetching or checking out a reference clone there could touch more than 1,000 files and pause an interactive turn that changed nothing in the brain. `max_bytes_written` and the free-space floor still count workspace writes, and the turn's scope summary still reports every changed path. A sibling such as `workspaces-old/` still counts. The journal's internal observation facts add `workspacePaths`.

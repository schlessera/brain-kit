---
"@schlessera/brain-common": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Restrict workspace access in default governed and strict turns to read-only inspection. These turns no longer scan writable workspace aliases, read checkout ignore policy, retain workspace change rows or charge workspace bytes. Existing retained history remains readable.

Add an authenticated per-session (and draft) code-changes preference API. Enabling it takes effect at the next admission and preserves the previous writable mounts, alias scan and per-file journal. The worker learns its mode through append-only turn context; read-only guidance names the session switch and managed worktree alternatives for edits, installs and builds.

Keep governed note writes live when the optional workspace is absent, retaining and charging newly created content until the next default admission seals it. Skip mounted checkout metadata traversal in inspection turns, preserve handoff prompts through actual preparation, and return actionable install refusals without denying checkout reads.

---
"@schlessera/brain-common": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Restrict workspace access in default governed and strict turns to read-only inspection. These turns no longer scan writable workspace aliases, read checkout ignore policy, retain workspace change rows or charge workspace bytes. Existing retained history remains readable.

Add an authenticated per-session (and draft) code-changes preference API. Enabling it takes effect at the next admission and preserves the previous writable mounts, alias scan and per-file journal. The worker learns its mode through append-only turn context; read-only guidance names the session switch and managed worktree alternatives for edits, installs and builds.

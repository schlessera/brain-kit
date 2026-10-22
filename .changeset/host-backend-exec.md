---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

Pass each app's resolved exec wrapper through backend construction, runtime
probes, Claude SDK workers and Pi tools. Explicit empty host configuration
disables the optional wrapper; standalone callers omitting it retain the
ambient fallback at the existing turn and tool-spawn boundaries.
Pi workers see each configured helper file, and only that file, in ordinary and
restricted views; a wrapper or killer that is not a regular file is refused
before any relay or worker starts, as is a nonregular wrapper for an ordinary
Claude worker.

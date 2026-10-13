---
"@schlessera/brain-ui-server": patch
"@schlessera/brain": patch
---

Require brain CLI 0.42.0 or newer before startup. Hygiene review introduced the 0.41.0 prerequisite; this release's additive scratch pin input raises the effective floor to 0.42.0 so every server-invoked command and flag is available. Update the content repository's `@schlessera/brain` pin and lockfile with the server before deploying.

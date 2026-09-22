---
"@schlessera/brain": patch
---

The `/brain-host` skill no longer frames the minimum `@schlessera/brain` version
as a one-release upgrade note. The server refuses to boot below
`MIN_BRAIN_CLI_VERSION`, which is a standing floor, and the skill now says so —
the old wording read as old news three releases after the release it named.

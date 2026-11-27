---
"@schlessera/brain-ui-sdk": patch
---

The worker launcher refuses a launch that has a startup view and writable areas but no `preparedOutput` (#4685). It throws a `WorkerHostError` naming the missing prepared output before anything is spawned; it used to stage through the copy-staged output path itself, which no host can complete, and so failed inside output staging. Every production caller already prepares native output and passes it as `preparedOutput`.

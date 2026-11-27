---
"@schlessera/brain": patch
---

The sync-judge scorer (`lib/sync/judge-score.ts`) leaves the published package (#4694). No entry point reached it; it moves next to its only consumer, the measurement script, as `scripts/sync-judge-score.ts`. The tarball loses that source file and its built output; no export or runtime behaviour changes.

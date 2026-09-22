---
"@schlessera/brain-backend-claude": patch
---

No behaviour change. A comment in `permission-hooks.ts` pointed at
`sdk-options.ts:89` for the project settings this backend loads; the line moved
to 96 and the pointer had come to name `forwardSubagentText` instead. It now
names `settingSources` alongside the line, so the next insertion above it is
recoverable rather than silent.

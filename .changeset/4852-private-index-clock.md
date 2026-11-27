---
"@schlessera/brain-ui-server": patch
---

The private index cache takes its clock as an internal option (#4852): `createPrivateIndexCache` accepts `now` and `timers`, defaulting to `Date.now` and the global `setTimeout` and `clearTimeout`, and reads time only through them. The production caller passes neither, so idle expiry is unchanged. Its tests pass their clock to the cache instead of replacing the process's globals and recognising the cache's timers by stack frame.

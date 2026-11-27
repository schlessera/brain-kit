---
"@schlessera/brain-ui-sdk": patch
---

`prepareWorkerOutput` is removed from `@schlessera/brain-ui-sdk/internal` (#4707). Copy-staged worker output, which no host could run since the full-copy startup view was removed, now lives in the package's test helpers only; production publication is native output (`prepareNativeWorkerOutput`), unchanged.

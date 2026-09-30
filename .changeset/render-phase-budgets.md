---
"@schlessera/brain-render-puppeteer": minor
---

Breaking before 1.0: `renderTimeoutMs` now covers page creation/rendering only; queue waiting and browser acquisition have separate `queueTimeoutMs` (30 s) and `browserTimeoutMs` (60 s) bounds, with cancellation-safe cleanup and bounded shutdown.

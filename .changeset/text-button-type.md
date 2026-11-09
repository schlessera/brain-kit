---
"@schlessera/brain-ui-kit": patch
---

`TextButton` now draws its own type: 12.5px Plus Jakarta Sans, or 10.5px JetBrains Mono for the `meta` tone. Its stylesheet read two custom properties that were never declared, `--bk-font-body` and `--bk-font-mono`, so every text action inherited its parent's font instead, usually 16px body text. A new unit test fails whenever the kit reads a `--bk-*` property it does not declare.

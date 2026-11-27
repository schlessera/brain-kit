---
"@schlessera/brain": patch
---

`brain validate`, and every hygiene detection, `brain audit --fix` and hygiene repair post-check that runs the same validation, read and parse each markdown file once instead of twice (#4785). The issues, their order, messages and details are unchanged.

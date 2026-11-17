---
"@schlessera/brain": patch
---

Core's two graph readers, behind `brain graph` and the supported `./queries` graph reads, now share one internal reader with an explicit CLI profile and UI profile (#1354). Both keep their former results, defaults, caps, ordering and errors. No `--json` shape, query result or export changes.

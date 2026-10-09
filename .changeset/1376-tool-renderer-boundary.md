---
"@schlessera/brain-ui-react": patch
---

A tool renderer that throws no longer takes down the app. The failing call
falls back to the generic tool view, including its approval card, and the
error is reported once.

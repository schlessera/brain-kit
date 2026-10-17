---
"@schlessera/brain-ui-sdk": patch
---

Refuse native worker output that deletes an ancestor directory of protected tier A inputs, even when its protected descendants are absent. Validate the whole publication before installing any output, while retaining ordinary directory deletion.

---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---
Discard failed Git packing outputs, preflight conservative headroom, and report existing garbage in maintenance and storage packing JSON. Hosted maintenance reserves a separate calculated packing stage while keeping ordinary worker allowances unchanged. Storage packing accepts a dry run and adds garbage accounting and a conservative packing requirement without changing existing headroom fields.

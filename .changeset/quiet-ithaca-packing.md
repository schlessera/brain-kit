---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---
Discard failed Git packing outputs, preflight conservative headroom, and report existing garbage in maintenance and storage packing JSON. Storage packing accepts a dry run and adds garbage accounting and a conservative packing requirement without changing existing headroom fields. Named skips use optional metadata while preserving the existing CLI reason enum.

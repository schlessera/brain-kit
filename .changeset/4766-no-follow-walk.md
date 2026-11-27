---
"@schlessera/brain-ui-sdk": patch
---

Maintenance and native output publication reach brain files through one no-follow parent walk. It refuses an empty, `.`, `..` or NUL-holding path segment before opening anything, closes its handle when a component fails, and each publisher keeps its own error message. A maintenance output path holding a NUL byte, already refused by the runtime's argument check, is now refused with "invalid maintenance output path".

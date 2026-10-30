---
"@schlessera/brain-ui-sdk": patch
---

Use held pidfd authority and confirmed process stopping before maintenance child enumeration. When the host cannot hold a pidfd for the worker, cancellation is reported unconfirmed and keeps the worker's admission.

---
"@schlessera/brain-ui-sdk": patch
---

Mask all host `/var` directories in governed, strict and maintenance workers,
including sockets under `/var/tmp`, `/var/spool` and `/var/snap`, while keeping
explicit read-only runtime inputs available.

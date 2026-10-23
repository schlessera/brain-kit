---
"@schlessera/brain-ui-server": patch
---

A hosted turn refused for a hardlink out of a masked provider folder now names the same masked file on every host. The check reads each directory in a fixed order instead of the filesystem's own.

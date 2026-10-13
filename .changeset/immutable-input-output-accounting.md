---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---

Keep complete immutable startup inputs outside the bounded staged-write allowance. Private copy-on-write output workspaces retain the 256 MiB default and aggregate admission, including after lower-only deletions. Release input copies and output namespaces on abrupt server exit, qualify actual writable staging before reporting host availability, and report named input-capacity refusals through boot/status without host execution fallback.

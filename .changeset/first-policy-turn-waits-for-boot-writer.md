---
"@schlessera/brain-ui-server": patch
---

The first provider-policy turn after the server starts is no longer refused with "An active peer did not retain the requested provider folders". A writer started with the server, such as the boot-time scratch prune, plans its retained folders before any turn has translated a type selector, so its plan lacks those folders. Admission now waits up to 30 seconds for such an earlier writer to finish instead of refusing at once. A peer still active at that bound refuses as before, and peers that are unsafe whatever they do next (unaccounted, unverified or unpinned host plans) still refuse immediately.

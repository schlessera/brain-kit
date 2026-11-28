---
"@schlessera/brain-ui-server": patch
---

A shared storage scan no longer refuses with `storage-scan-worker-reap-unavailable` when an inherited worker exits between its liveness probe and its `/proc` read. Before, the failed read counted the vanished worker as alive. Now the pid is probed again: a pid that no longer exists is dead, and a live pid without readable procfs still counts as alive.

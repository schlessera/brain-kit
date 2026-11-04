---
"@schlessera/brain-backend-claude": patch
---

Moving an idle Claude session into the transcript archive no longer blocks the hosted server's event loop (#2898). The move, removal of the live copy, conflict set-aside and index update now wait for their file and directory fsyncs asynchronously. Order, verification and durability are unchanged. Before deleting live bytes, the sweep checks again, in the same step that deletes, that no turn has started on the session and that no restore or retirement has moved its archived copy in the meantime. Otherwise it leaves both copies for the next sweep's recovery. Restoring an archived session stays synchronous on purpose, so no turn or sweep can run between its validation and its publication.

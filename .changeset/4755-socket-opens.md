---
"@schlessera/brain-ui-react": patch
---

The connection store's `socketOpens` now counts only sockets that reached `open` (#4755). Creating a socket no longer increments it: the lease calls a new `noteSocketCreated` action, which resets the previous socket's capability flags, refusal count and close code as before without counting an open. The first connection of a lease raises the counter by one instead of two, so the readers keyed on it (the worker-host status, the content-renderer declarations, the notification zone's first socket) run once per connect, and a connectivity probe keeps its failure when a socket was only created while it ran.

---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-pi": patch
---

Worker launches no longer walk the server's own `node_modules` again for read paths that cannot change while it runs. The egress wrapper's read envelope and the pi worker's two read envelopes are computed once per process and copied for each launch; the mounts a worker gets are unchanged. Read paths taken from a launch command are still computed on every launch.

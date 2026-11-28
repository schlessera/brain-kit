---
"@schlessera/brain-ui-sdk": patch
---

Launch qualification proves each directory on a worker's route to private state from one open descriptor: its mount, device, owner and mode are read through a single `O_PATH|O_NOFOLLOW` open, never through a second lookup of its path (#5055). A directory on an idmapped host mount, or one whose owner the host cannot read, proves nothing, so the state stays exposed.

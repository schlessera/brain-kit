---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Keep the hosted server answering while native file observations and the Claude transcript archive's daily scan marker are written to a loaded disk. Saving and restoring a session's native file observations, including creating their storage directory, now waits on the file system off the event loop. Saves land in call order, and each native read or write still waits for its observation to be durable before it proceeds. The archive's scan marker is written the same way, and concurrent sweeps in one process still scan once. File and directory fsync, atomic replacement, the private modes, the redirect and alias refusals and the refusal of a write whose observation cannot be saved are unchanged. `NativeFileVersions` on the internal entry now returns promises from `restore` and its recording methods.

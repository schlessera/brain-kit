---
"@schlessera/brain-ui-sdk": patch
---

Restricted autonomous workers no longer see the brain's `.git`: a directory is masked by an empty read-only tmpfs and a gitlink file cannot be opened, which hides git's fsmonitor socket, hooks and configuration. A `.git` symlink, which cannot be masked, refuses the restricted turn. Other Unix sockets that a host process listens on inside the read envelope remain reachable; this residual is documented.

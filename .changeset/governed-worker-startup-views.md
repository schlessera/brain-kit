---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Restore direct writes for ordinary hosted turns with the governed profile while keeping policy and runtime configuration protected. Strict remains opt-in and autonomous workers retain their restricted permissions. Snapshot consumers run configuration from immutable startup views, with validated maintenance output publication and separate persistent write areas. Report the profile, protected paths and shared-uid limits in host status and the agent context; reconcile and incrementally index governed turns on completion.

Bound immutable inputs and publication copies in a separate admitted 256 MiB output-staging tmpfs by default, with validated host overrides, Retry on busy admission and ENOSPC on overflow. Capture file-browser ignore bytes without copying unrelated repository data.

Require the operational database and private server state outside the brain for every hosted profile. Refuse invalid layouts at boot with named migration guidance and matching status diagnostics, preserving the worker masks. Hosts must install util-linux nsenter and allow setns in the namespace seccomp profile for bounded staging.

Revalidate complete startup inputs, retain native-write path locks through staged publication, preserve peer-created output names, and handle publication refusals without unhandled worker lifecycle rejections.

Refuse database, WAL/SHM and private-state aliases exposed inside the brain by hardlinks or bind mounts, including new database paths beneath mounted state parents. Preserve valid outside-only aliases and mask resolved database, token and quarantine targets.

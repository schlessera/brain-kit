---
"@schlessera/brain-ui-server": patch
---

Refuse the legacy host fallback while a provider folder policy is active (#2284). A host process's descendants cannot be bounded, so on a never-governed host a command that would run brain code on the host now throws `HostFallbackRefusedError`, naming the folders, before any process starts. This covers complete, streaming and synchronous commands, gated or not. An invalid policy file counts as unknown and refuses too. Without provider folders nothing changes.

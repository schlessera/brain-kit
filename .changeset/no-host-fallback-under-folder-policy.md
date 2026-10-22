---
"@schlessera/brain-ui-server": patch
---

Refuse the legacy host fallback while a provider folder policy is active (#2284). A host process's descendants cannot be bounded, so on a never-governed host a command that would run brain code on the host now throws before any process starts: `HostFallbackRefusedError` naming the folders, or an existing peer refusal that is checked first. This covers complete, streaming and synchronous commands, gated or not, and folders a running writer still retains after the policy changes. A policy file that cannot be read or parsed counts as unknown and refuses too. Without provider folders host fallback still runs, except that an ungated command now also refuses beside a running writer whose folder provenance is unknown.

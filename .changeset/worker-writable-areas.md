---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": patch
"@schlessera/brain": minor
---

Give hosted agent turns verified persistent scratch and workspace areas (#1626), now integrated with the 0.42.0 profiles. Governed is the interactive/voice default: ordinary brain files are writable except protected paths, and scratch/workspaces use their canonical destinations. Strict keeps an immutable read-only execution view and writes private copies at `/tmp/brain-worker-areas/scratch` and `/tmp/brain-worker-areas/workspaces`, with validated publication after exit; links use the canonical brain destinations. Scratch is created when missing and refused when redirected by a symlink or not gitignored; an existing workspace remains unavailable when its boundary cannot be verified.

There is no agent HOME overlay. Host home is read-only and may be masked by the resolved profile; fresh XDG directories live in size-limited turn temp. The generated note states the actual profile, writable paths and output-link rules. CLI read-only refusals name the scratch route, and scratch serving/pruning uses descriptor-safe operations on Linux. Autonomous turns retain their restricted envelope.

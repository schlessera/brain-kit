---
"@schlessera/brain-ui-sdk": minor
---

Provider-restricted governed turns now run when the worker has its own UID (#2696). Before the payload starts, the server checks the worker's mounted provider folders, masks and private index through a gated brain view from the identity helper. The helper protocol gains an additive `view` operation. A helper without it still refuses these turns before the payload starts.

---
"@schlessera/brain-common": patch
"@schlessera/brain": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---

Symlink-safe path containment now has one implementation, in the new internal entry `@schlessera/brain-common/internal/safe-path` (#2506). It holds `isWithin`, the containment primitive whose equality, separator, trailing-separator and normalisation answers are explicit parameters, and one canonicalisation algorithm with a synchronous and an asynchronous variant. core's `safeResolve`, the SDK's `resolveInRepo` and the server's `safeResolve` are thin wrappers over it, and the scratch-directory copies read the shared `BRAIN_SCRATCH_DIR`. Each caller keeps its own answers, with two exceptions: the server's `safeResolve` now refuses a path through a symlink cycle, as core and the SDK already did, instead of answering a path that resolves nowhere; and the server's check that core's query entry lies inside its package no longer refuses a directory whose name starts with `..`. `safeResolve` and `SCRATCH_DIR` stay exported from `@schlessera/brain/module` with their signatures and answers unchanged. The new entry is internal and carries no compatibility promise.

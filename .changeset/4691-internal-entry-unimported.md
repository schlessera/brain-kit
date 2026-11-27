---
"@schlessera/brain": patch
---

`@schlessera/brain/internal` drops 24 re-exports that no first-party package imports from it (#4691): `COMPUTE_JOB_ID`, `ComputeStateError`, `GEMINI_FLASH_MODEL`, `GovernancePolicySchema`, `WriteRefusedError`, `assertScratchWritable`, `collectModuleRenderers`, `collectStats`, `computeBrainKey`, `computeJobView`, `createComputeDriver`, `geminiCompletions`, `inertGeneratedText`, `isInScratch`, `isWriteRefusal`, `jobOutput`, `jobSettled`, `loadComputePackage`, `resolveComputeStateDir`, `resolveWritable`, `rewriteGeneratedRegion`, `runRegistry`, `scratchName` and `splitFrontmatterBlock`. The internal entry carries no compatibility promise. Modules keep taking the helpers they use from `@schlessera/brain/module`; the declarations themselves are unchanged.

---
"@schlessera/brain": minor
---

New `@schlessera/brain/testing` export: a contract suite for each of the four core seams — `runEmbeddingProviderContract`, `runCompletionProviderContract`, `runAgentRunnerContract` and `runSkillEmitterContract`. A provider outside this repository can now run the same keyless checks every built-in runs: vectors as wide as `dimensions`, cancellation that never hangs, an honest `vision` flag, `timeoutMs` honoured, emitted skill layouts that prune what was dropped. Pass `{ describe, expect, test }` from your test runner; the module depends on none.

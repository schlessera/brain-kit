---
"@schlessera/brain": patch
---

The pre-commit hook no longer rejects a commit in a brain that has no tests.
`bun test` treats "no test files" as an error, and the hook runs it whenever
the staged change touches `brain.config.*` — so `/brain-init`'s single commit,
the one the interview promises as its revert point, was refused on every
brand-new brain. The hook now tells "nothing to run" apart from "tests failed"
and says which it saw.

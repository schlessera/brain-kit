---
"@schlessera/brain": patch
---

Internal (#4844): the `brain` CLI entry is split in two with no behaviour change. `cli/main.ts` exports `runBrainCli(argv)`, which runs one invocation and resolves to its exit code (a usage error is 1, any other failure 2, with the message on stderr); the `brain` bin calls it once and keeps the stream-backed console, stdio completion and the exit. Output, exit codes, `--json` shapes and flags are unchanged.

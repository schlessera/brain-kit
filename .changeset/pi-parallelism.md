---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

pi backend parallelism.

- **Keyed locks replace the pi backend's global write mutex**: file writes
  lock per path, brain document tools share one key, and bash locks the
  repo-git key only for git-staging/history and brain-CLI write commands
  (`bashLockKey`, shared with the Claude backend via ui-sdk). Builds, greps
  and other read-shaped bash run lock-free, so pi's parallel sibling tool
  calls and parallel sessions actually execute in parallel. Injecting the
  legacy `writeLock` option restores whole-lock serialization.
- **`subagent` fan-out**: the `pi-subagents` extension's tool joins the
  default allowlist (parity with Claude's auto-allowed Agent tool), and the
  system-prompt brief names it when the package is installed.
- **Backend-honest execution brief**: `buildSystemPromptAppend` gains an
  `execution` option (subagent tool name, per-turn-process semantics,
  parallel tool calls). The Claude backend's text is unchanged; pi's brief
  now tells the model to batch independent tool calls (they run
  concurrently) and no longer references subagents it doesn't have.

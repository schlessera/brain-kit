---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-server": minor
---

Harden the agent turn lifecycle against the failure modes found in the
2026-08-23 fan-out incident (23 background subagents killed, tool aborts
misread as user denials, one long Bash freezing every session's writes).

- **Configurable turn timeout.** `BRAIN_UI_TURN_TIMEOUT_MS` now feeds
  `createApp()` (explicit option still wins); the host passes the live budget
  to backends as `StartTurnRequest.turnBudgetMs`, and the Claude backend puts
  the real number in the system prompt so the model sizes work to the cap.
- **Keyed write locks replace the global mutex** (`createKeyedLock` in
  brain-ui-sdk; the old `createWriteLock` remains for the pi backend). The
  Claude backend now serializes per target file for Write/Edit/NotebookEdit,
  repo-wide only for git staging/history commands (and `brain sync|import`),
  and on one shared key for the brain document tools. Everything else — curl,
  builds, tests — takes no lock. Lock waits are bounded (`lockWaitMs`,
  default 30s, under the CLI's 60s hook timeout) and expire into a DENY with
  an explicit "retry" reason instead of stalling into the CLI's misleading
  "hook did not respond" refusal.
- **Agent calls are rewritten to run in the foreground.** The SDK's Agent
  tool backgrounds subagents BY DEFAULT, and a background subagent dies with
  the per-turn subprocess. A PreToolUse hook rewrites
  `run_in_background` to `false` (and denies `isolation: "remote"`, whose
  results nothing could collect), telling the model why via
  `additionalContext`.
- **Turn-lifecycle brief in the system prompt append**: per-turn subprocess
  semantics, the hard budget, incremental-write guidance, and how to read
  "the user doesn't want to take this action" / lock-busy errors (usually a
  cancelled turn or contention, not a human refusal).
- **Approvals and ask-user cards survive disconnects.** A phone dropping its
  socket at screen lock no longer silently denies pending approvals; they are
  held (bounded by the turn timeout), re-delivered on reconnect, and an
  approval raised with no client attached logs a warning instead of parking
  invisibly. Location and mask requests keep their fail-fast behavior.

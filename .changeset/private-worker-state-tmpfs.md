---
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Each Claude worker now gets its own private, size-limited tmpfs for its runtime state (#1625), so parallel sessions no longer share, and run out of, the host's `/dev/shm`. The allowance is 64 MiB per worker by default (`BRAIN_UI_WORKER_STATE_BYTES`). Before a worker launches, its whole allowance is reserved against a server budget, which defaults to the allowance times `MAX_CONCURRENT_SESSIONS` and can be set with `BRAIN_UI_WORKER_STATE_BUDGET_BYTES`. Invalid values stop the boot with the variable's name. The server copies the conversation in before the runtime starts and copies validated transcripts and memory out after the worker's namespace is gone. Nothing is left behind if the server dies.

Two new first-party failure classes, both registered in `FIRST_PARTY_FAILURE_CLASSES`, get their own cards. `worker_state_busy`: the budget is held by running conversations; the turn is refused before launch, nothing is sent, and Retry runs it. `worker_state_exceeded`: the turn filled its allowance; it ends as this failure even if the runtime finished its answer, because the rest was not saved. A conversation whose saved state does not fit the allowance stays `session_too_large`; the old 128 MiB bound is gone. Claude workers need bubblewrap 0.7 or later.

Agent memory written during a turn is now kept (#1626): new or changed `memory/*.md` notes are persisted with the same alias, size and concurrent-change checks as transcripts. A note another conversation changed meanwhile is refused alone and named, and nothing is deleted.

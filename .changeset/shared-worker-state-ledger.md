---
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-react": minor
---

Concurrent Claude turns now share the `/dev/shm` runtime-state tmpfs through a reservation ledger (#1625). Each turn reserves what it copies in plus its growth reserve before copying anything, so a second parallel session no longer fails with `ENOSPC`. A turn that fits but finds the space held by running conversations refuses before launch with the new failure class `worker_state_busy`; a running turn that outgrows its reservation with no free space left is stopped as `worker_state_exceeded`. Both have their own error card with Retry, and reports keep the class. Autonomous turns reserve their growth room too.

Agent memory written during a turn is now kept (#1626): new or changed `memory/*.md` notes are persisted with the same alias, size and concurrent-change checks as transcripts. A note another conversation changed meanwhile is refused alone and named, and nothing is deleted. `docs/hosting/agent-workers.md` gives the sizing rule for parallel sessions.

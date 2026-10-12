---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

A file the agent links in turn temp (`$BRAIN_WORKER_SCRATCH`, `/tmp` or a write under `$HOME`) no longer becomes a dead link when the turn ends (#1655). Once the worker has exited, the backend copies each linked file into `.brain/scratch/turns/<turnId>/` and the saved answer links the copy, with nothing shown in the chat. The copy follows no symlink, refuses hard-linked files and directories, and is bounded at 128 MiB per file, 256 MiB and 64 files per turn; a refused file keeps its original link. Every copy and refusal is stored as a `promotion` or `promotion_refused` governance event (`GET /api/governance/events`). To make this possible, turn temp is now a private directory the server creates on a tmpfs apart from the brain (its temporary directory if that is a tmpfs, otherwise `/dev/shm`) instead of a tmpfs only the worker could see, so in Docker `/dev/shm` must also fit what turns write there. For backend authors, `StartTurnRequest.turnId` passes the host's turn id, and `BackendActivityEvent` gains the `promotion` and `promotion_refused` variants.

---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-server": minor
---

`BRAIN_UI_EXEC_WRAPPER`: an absolute path to an executable that agent and brain
CLI subprocesses are launched through, as `<wrapper> <program> <args…>`. It lets
a host run those children as another user without the packages knowing how. The
wrapper is an argv[0], never a command line — no shell parses it, so a value
full of metacharacters is a filename rather than a command. A wrapped child
leads its own process group and an abort signals the group, because a uid drop
otherwise makes `kill(2)` fail with EPERM and leaves an aborted turn running.

Every brain CLI launch is covered too, not only the agent's tool spawns: the CLI
imports the repository's `brain.config.ts`, so a search executes repository code
exactly as a tool call does.

`BRAIN_UI_EXEC_KILLER` is the companion seam. `kill(2)` matches uids and group
membership grants no exception, so once a wrapper has dropped privileges the
server can signal nothing at all; a host that drops uid supplies an authorised
helper, invoked as `<killer> <pgid> <TERM|KILL|INT>`. With neither configured,
and with a wrapper that has not changed uid, the group signal is used directly.
A cancellation that fails entirely is reported rather than swallowed.

Unset — which is every existing deployment — every spawn is exactly what it was.

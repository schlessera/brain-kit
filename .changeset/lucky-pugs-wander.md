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

Unset — which is every existing deployment — every spawn is exactly what it was.

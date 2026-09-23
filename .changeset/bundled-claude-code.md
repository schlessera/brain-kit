---
"@schlessera/brain-ui-server": minor
"@schlessera/brain": minor
---

`CLAUDE_CODE_PATH` no longer defaults to `/usr/local/bin/claude`. Unset, a chat turn runs the Agent SDK's built-in Claude Code binary, so the lockfile decides the version. A host that relied on the old default without setting the variable now runs the SDK's binary. That version may differ from the one the host had installed; set `CLAUDE_CODE_PATH` to keep the old binary.

The core Claude runner behind `brain sync` resolves its binary the way chat does: `CLAUDE_CODE_PATH` first, then the Agent SDK's built-in binary when the SDK is installed next to `@schlessera/brain` (a new optional peer dependency), then `claude` on `PATH`. It no longer needs a separate `claude` install. The server still keeps `CLAUDE_CODE_PATH` to itself. A brain repo that runs `brain sync` on a host without `claude` needs the SDK installed alongside `@schlessera/brain`.

---
"@schlessera/brain": patch
---

Every `brain` invocation now loads only the core command it runs (#4793). The core command table holds each command's one-line summary and a loader, so `brain --version` and `brain --help` load no command module and `brain read` loads `read` alone, where before all 39 core commands loaded before the arguments were read. Help text, exit codes, unknown-command errors and every `--json` envelope are unchanged. With `NODE_DEBUG=brain-mcp-startup`, `brain mcp` also logs a `static` phase: the time from process start to the first statement of the bin's `main`.

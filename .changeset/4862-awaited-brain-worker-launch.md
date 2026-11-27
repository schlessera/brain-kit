---
"@schlessera/brain-ui-server": patch
---

The masked `brain` CLI runs (private index builds, provider taxonomy, hosted compute) and turn data tree maintenance runs now await the worker launcher instead of blocking the server's event loop while bubblewrap sets up the sandboxed worker (#4862). Other sessions' frames, health probes and WebSocket pongs keep running during the launch. An abort that arrives while the launch is pending stops the worker as soon as it launches, and the run reports the abort as before.

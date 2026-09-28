---
"@schlessera/brain-ui-server": patch
---

`BrainClient.sync()` still runs bare `brain sync`, which now runs `brain sync run` and starts the agent only for what needs judgment. A sync that stops for judgment without an agent (exit 3) rejects with its report as the message.

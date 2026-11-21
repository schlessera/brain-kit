---
"@schlessera/brain": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Register hosted Claude brain reads from static package definitions before runtime startup, and forward calls to one sandboxed MCP process per turn. New first-party relayed sessions can discover deferred tools while keeping five common reads inline. Existing sessions retain their original tool roster and search setting.

Resolve module inventories in a sandbox on each new session, overlapping only independent preparation before query dispatch. Keep the inventory duration as an internal startup span; resumed sessions retain their roster without another check.

Apply the runtime exec-wrapper and shell-startup environment policy to brain subprocesses, keep restricted version probes credential-free, and share one turn-temp allowance between the runtime and forwarding process with cleanup on rejected exit observers.

---
"@schlessera/brain": minor
"@schlessera/brain-backend-claude": minor
---

Register hosted Claude brain reads from static package definitions before runtime startup, and forward calls to one sandboxed MCP process per turn. New first-party relayed sessions can discover deferred tools while keeping five common reads inline. Existing sessions retain their original tool roster and search setting.

Bridge only a project `brain` entry that is exactly `bun node_modules/.bin/brain mcp`, enabled by the project's settings and served by the host's own `@schlessera/brain` version, and run the forwarding worker read-only on every profile. Resolve module inventories in a sandbox on each new session, overlapping only independent preparation before query dispatch. Keep the inventory duration as an internal startup span; resumed sessions retain their roster without another check.

Apply the runtime exec-wrapper and shell-startup environment policy to brain subprocesses, keep restricted version probes credential-free, and share one turn-temp allowance between the runtime and forwarding process with cleanup on rejected exit observers.

The static read definitions ship as `@schlessera/brain/internal/read-definitions`, which loads under Node without `bun:sqlite`, so `@schlessera/brain-backend-claude` still imports under Node.

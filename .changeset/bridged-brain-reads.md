---
"@schlessera/brain": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-sdk": minor
---

Register hosted Claude brain reads from static package definitions before runtime startup, and forward calls to one sandboxed MCP process per turn. New first-party relayed sessions can discover deferred tools while keeping five common reads inline. Existing sessions retain their original tool roster and search setting.

Bridge only a project `brain` entry that is exactly `bun node_modules/.bin/brain mcp`, enabled by the project's settings and served by the host's own `@schlessera/brain` version, and run the forwarding worker read-only on every profile. Resolve module inventories in a sandbox on each new session, overlapping only independent preparation before query dispatch. Keep the inventory duration as an internal startup span; resumed sessions retain their roster without another check.

Apply the runtime exec-wrapper and shell-startup environment policy to brain subprocesses, keep restricted version probes credential-free, and share one turn-temp allowance between the runtime and forwarding process with cleanup on rejected exit observers.

The static read definitions ship as `@schlessera/brain/internal/read-definitions`, which loads under Node without `bun:sqlite`, so `@schlessera/brain-backend-claude` still imports under Node.

The inventory check now has its own 8-second bound before a new chat's first request, falling back to stdio, and releases its turn-temp handle when the helper exits, so under a separate worker UID the verdict arrives at exit instead of after a 30-second wait. The forwarder treats the worker's exit as the end of its transport, so a crashed sandboxed `brain mcp` fails its calls at once.

A session that retained tool search resumes only through its relay to the first-party origin and is refused by name otherwise. Past its bound the inventory check returns the stdio fallback at once while the worker's cleanup continues detached, and a rejected worker exit closes the forwarder transport too.

Every bridge worker is signalled at most once, through the launcher's new asynchronous `killAsync` (a separate-UID signal no longer blocks the host), and releases its turn-temp handle when it exits. The inventory verdict never waits for worker cleanup, and closing the forwarder never waits for a launch that has not returned and waits for a started worker's cleanup only within the exit wait, so a turn's terminal frame is never held by bridge cleanup.

Turn scope receives a guarded handle whose kill is that same single signal, and a bridge worker's turn-temp allowance is released once its exit is confirmed and storage closed, without waiting for its pipes, so the forwarder can reserve what the inventory check held.

A brain without its index, or whose only module tools belong to dormant modules, is judged as the brain's own MCP server would serve it: no index keeps stdio, and dormant tools do not count. Every bridge worker frees its turn-temp allowance through one release as soon as its exit is confirmed and storage closed; the inventory verdict waits for that release, and a forwarder start refused by a full budget is retried on the next read. An asynchronous separate-UID request that loses control now stops its supervisor without blocking the host.

An index in WAL mode qualifies only with its sidecars present; a bridge worker's reservation is freed only once both its exit and its storage close are confirmed; and a failed separate-UID supervision is terminated and closed off the host's event loop.

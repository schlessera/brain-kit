---
"@schlessera/brain-backend-pi": minor
---

The pi backend's `brain_graph` now also returns `nodes`: the `path`, `title`, `type`, `summary` and `updated` of every document its edges touch, as the MCP tool does. A pi agent no longer has to read each neighbour to learn what it is. `BrainAccess.graph()` now resolves to `{ edges, nodes }` instead of the bare edge list, and its reads come from one snapshot.

---
"@schlessera/brain-backend-pi": minor
---

The pi backend's `brain_graph` now also returns `nodes`: the `path`, `title`, `type`, `summary` and `updated` of every document its edges touch, as the MCP tool does. A pi agent no longer has to read each neighbour to learn what it is. `BrainAccess.graph()` now resolves to `{ edges, nodes }` instead of the bare edge list, and its reads come from one snapshot.

`brain_graph` and `brain_list` in the pi backend no longer cut their JSON mid-string at 30,000 characters, which left text that did not parse and a graph that lost nodes. They keep that budget, and cut by structure instead. A graph keeps its first edges in walk order, with the nodes of their endpoints, and adds `truncated: true` and `omitted_edges`. A listing drops whole rows and adds `truncated: true` and `omitted`. The JSON always parses, and every returned edge has its endpoint nodes.

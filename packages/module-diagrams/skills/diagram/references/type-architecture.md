# Architecture

Show tiers or trust boundaries using flat `groups: [{id,label,members}]` (default
budget 3 zones). Nodes use redundant role tags above name/sub: `input`, `store`,
`external`, `optional`, `boundary`, or default/focal agents. Keep one dominant
flow and at most two focal elements. Nodes default to the universal 9-node and
12-edge budgets. Primary, link, default and dotted async paths retain approved
arrow heads and rounded orthogonal routing.

For meaningful nested network hierarchy, add `containment.scopes` with explicit
`{id,label,kind: admin|traffic,parent?,at,size}`. Each architecture node then names
`kind: compute|endpoint|managed` and its innermost `parent`; endpoint also names
its managed `target`. Managed nodes belong in an admin band outside every traffic
scope; compute/endpoint nodes belong in traffic. Admin scopes are horizontal dashed bands with 4px corners and a 24px header;
traffic scopes are rounded boxes. Direct siblings share a row when the admin
parent is wide/square, otherwise a column; nested traffic levels alternate that
axis. Bounds and declared parents are checked, not relocated. `peering: true`
edges join distinct traffic scope IDs. Keep at most 2 admin bands, 4 traffic
scopes and 8 nodes; excess warns. Every generated bounds rect carries the
provider-neutral containment metadata and its own coordinates.

Examples: [flat relay](examples/architecture.diagram.yaml),
[nested boundaries](examples/architecture-containment.diagram.yaml).

Adapted from the pinned MIT upstream grammar at
`b46c9701f035844a20b13ab0551315977188933b` (see `UPSTREAM.md` and `LICENSE`).
Brain-kit uses DM Serif Text / Plus Jakarta Sans / JetBrains Mono and canonical
opaque light/dark/print tokens; amber is focal, all displayed text stays at least
9px, print is white. Do not copy upstream colours, alpha ink, or font sizes.

Every example is a standalone YAML document (JSON syntax is valid YAML), dated
2026-07-12 in the Odysseus example world. Use `brain diagram check homecoming.diagram.yaml --json` before
rendering. Author `at` and `size` on the 4px grid; the builder routes connectors
and never moves nodes. Edge order is authored routing priority: reserve self
loops and outside cycles before crowded later routes. A valid spec may have
editorial warnings; split overview/detail instead of dropping content.

Inline figures stay at native size. An optional complete `layouts.narrow` supplies
320px authored node placement; otherwise use summary + Open diagram. Do not
shrink, scroll the inline drawing, or invent automatic placements.

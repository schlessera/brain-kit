# Tree

With `hierarchy: true`, author the root above children; `direction: right`
selects a horizontal hierarchy with root to the left. Explicit hierarchies attach
parent bottom → child top (right → left horizontally), using separate fanned
orthogonal branches. Legacy generic placement retains its existing routing. Boxes use name/sub
without an invented agent tag; an explicit tag is available. Branches are
orthogonal and have no direction arrow heads. Use `hierarchy: true` to enforce one parent per child. Legacy common v1 trees
with shared children produce an actionable warning instead of becoming invalid;
cycles remain errors. A shared child or cycle belongs in dependency instead.
Warn above 4 levels (root is level 1), 5 items across a complete level, and the universal
9-node/12-edge budgets. Keep a single focal root when useful; never exceed two.

Example: [responsibilities](examples/tree.diagram.yaml).

Adapted from the pinned MIT upstream grammar at
`b46c9701f035844a20b13ab0551315977188933b` (see `UPSTREAM.md` and `LICENSE`).
Brain-kit uses DM Serif Text / Plus Jakarta Sans / JetBrains Mono and canonical
opaque light/dark/print tokens; amber is focal, all displayed text stays at least
9px, print is white. Do not copy upstream colours, alpha ink, or font sizes.

Every example is a standalone YAML document (JSON syntax is valid YAML), dated
2026-07-12 in the Odysseus example world. Use `brain diagrams check --json` before
rendering. Author `at` and `size` on the 4px grid; the builder routes connectors
and never moves nodes. Edge order is authored routing priority: reserve self
loops and outside cycles before crowded later routes. A valid spec may have
editorial warnings; split overview/detail instead of dropping content.

Inline figures stay at native size. An optional complete `layouts.narrow` supplies
320px authored node placement; otherwise use summary + Open diagram. Do not
shrink, scroll the inline drawing, or invent automatic placements.

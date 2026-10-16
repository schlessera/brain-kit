# State machine

Use `shape: state|initial|final`: state is an 8px rounded box, initial a filled
6px dot in a 12px authored box, final an 8px ring with a 5px filled centre in a
16px box. Initial has no incoming transition; final has no outgoing transition.
Use `event [guard] / action` transition labels, omitting unused sections.
Missing event labels warn except on the initial transition. More than twice as
many transitions as state boxes (excluding initial/final markers) warns, alongside universal 9-node/12-edge budgets.
Self transitions use separate perpendicular ports and the kit's rounded
orthogonal path rather than upstream free curves. Give loops room above the
state and route them before later congesting edges. Omitted shape keeps v1 boxes.

Example: [voyage lifecycle](examples/state-machine.diagram.yaml).

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

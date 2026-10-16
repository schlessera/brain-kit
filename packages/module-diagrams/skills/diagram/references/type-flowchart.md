# Flowchart

Use node `shape: start|end|step|decision|merge`: start/end are oval terminals,
step is a rectangle, decision a diamond, merge a filled 4px dot. Omitted shape
keeps the generic v1 box. Decision labels fit the diamond's central half-width
and half-height. Every decision exit must have an explicit outcome label;
more than 3 exits warns. Prefer top-down progression, Yes to the right and No
below where the authored layout allows it. Focal marks the consequential decision
or happy path; the universal 9-node/12-edge/two-focal budgets apply. Shaped ports
use distinct perpendicular cardinal attachments; split a crowded junction.

Example: [safe homecoming](examples/flowchart.diagram.yaml).

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

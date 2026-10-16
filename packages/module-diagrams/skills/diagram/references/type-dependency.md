# Dependency graph

Use this for shared children or cycles; an explicitly ranked tree-shaped graph
warns to consider tree. Node `rank` is an optional nonnegative integer; rank 0 is
entry, deeper ranks are authored below earlier ranks. Missing ranks warn explicitly;
a generic unranked source is never presented as a verified ranked layout.
Same-rank rows should align, with at least 120px separation between ranks;
misalignment or tighter spacing warns without moving authored nodes. Upward edges require
`cycle: true` and a visible `label` such as CYCLE. A cycle gets the outside-right
orthogonal lane, amber dashed paint and matching label. Reserve it first in edge
order. More than one highlighted cycle warns; focal nodes with a cycle warn
because the cycle already consumes the accent budget.

The top-right `N IN` badge is computed from incoming edges on every node (including 0 IN and 1 IN); do not author a contradictory count. Forward leaves use a solid muted
ground, external nodes retain their external treatment. Warn beyond 4 ranks,
9 nodes and 1 cycle. The upstream 14-edge allowance does not remove the common
12-edge warning: both are editorial guidance, never a reason to drop edges.

Example: [raft readiness](examples/dependency.diagram.yaml).

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

# ER / data model

Each entity node can add `fields: [{name,type?,key?: PK|FK}]`. ENTITY and the entity
name sit above a divider; fields use JetBrains Mono with `#` for PK and `→` for
FK. Author enough height for every field (12px minimum line boxes plus padding);
no truncation or below-9px text. This is an entity model, not an SQL index or
column-anchor schema.

Relationships are orthogonal lines without direction arrow heads. Declare
`fromCardinality` and `toCardinality` together using `1`, `N`, `0..1`, or `1..*`.
Endpoint labels have their own opaque, readable boxes 12px outside the entity
boundary and 8px beside the connector. A centred relationship `label` is optional.
More than 8 entities warns; universal edge/focal/callout budgets also apply.
Omitted fields/cardinalities preserve legacy generic v1 figures.

Example: [voyages and provisions](examples/er.diagram.yaml).

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

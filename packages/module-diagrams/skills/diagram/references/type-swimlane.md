# Swimlane

Use for responsibility and handoffs. `nodes` holds process steps; `axis: { kind: swimlane, lanes: [{id,label}], steps: [{node,lane}] }` declares lane order and step order. Every step has exactly one declared lane owner. `edges` connects steps; highlight the single important handoff with `kind: primary`. Order derives positions; do not supply `at`.

Budget: five lanes, nine steps, twelve edges, two focal elements/callouts. Overruns warn and ask for overview/detail. Lanes are labeled, steps stay within their owner lane and handoffs cross the divider. A narrow surface that cannot keep full type shows summary and Open diagram. No data charts, animation or hidden/customer service blueprint semantics.

Canonical shipped example: [`examples/swimlane.diagram.yaml`](examples/swimlane.diagram.yaml) (Odysseus world, pinned 2026-07-12 context). Adapted from diagram-design at the module’s pinned upstream revision; brain-kit’s approved skin and sequence ruling #2092 take precedence.

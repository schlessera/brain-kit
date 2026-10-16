# Gantt

Use for dated tasks and overlap. `axis: { kind: gantt, tasks: [{node,start,end,phase?}], phases?: [{id,label}], marker?: YYYY-MM-DD }` references labeled nodes. Start/end are real ISO days with end at or after start. Task order sets rows; durations and start positions are proportional to dates. Author the optional marker explicitly; no clock-dependent today. Phase IDs must be declared.

Budget: twelve tasks, five parallel tasks per phase, universal nine-node default and at most two focal/callout elements. Each editorial overrun warns; invalid dates/ranges/references refuse. Phase grounds and labels group rows; focal bars use redundant border/weight treatment. No dependency arrows in v1, animation, terminal or sketchy variants. Dates belong on the axis rather than task labels. Narrow inline space uses summary/Open diagram when it cannot fit.

Canonical shipped example: [`examples/gantt.diagram.yaml`](examples/gantt.diagram.yaml) (Odysseus world, pinned 2026-07-12 context). Adapted from diagram-design at the module’s pinned upstream revision; brain-kit’s approved skin and sequence ruling #2092 take precedence.

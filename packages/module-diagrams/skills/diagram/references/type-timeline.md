# Timeline

Use for dated milestones. `axis: { kind: timeline, events: [{node,date}] }` references labeled nodes in chronological order. Dates are real ISO calendar days (`YYYY-MM-DD`); unequal intervals receive unequal spacing. Equal dates share their date position; separate details if labels cannot fit. No manual `at`, fake equal spacing or inferred wall-clock today.

Events alternate above/below a labeled baseline with drops and dots. A focal milestone uses redundant size/weight emphasis. Universal budget: nine events, twelve relationships and two focal/callout elements. A tenth event warns. Keep labels concise; use summary/Open diagram when the available width cannot preserve readable type.

Canonical shipped example: [`examples/timeline.diagram.yaml`](examples/timeline.diagram.yaml) (Odysseus world, pinned 2026-07-12 context). Adapted from diagram-design at the module’s pinned upstream revision; brain-kit’s approved skin and sequence ruling #2092 take precedence.

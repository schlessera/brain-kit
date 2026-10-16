# Funnel

Use `positional.pyramid.layers` in top-to-bottom order for type funnel. Quantitative values decrease toward conversion, and every supplied boundary width is proportional to its value. Without values, the hierarchy uses an explicitly qualitative linear narrowing. Labels, node sublabels and optional side annotations must remain readable; never fake counts by giving unequal drops equal widths. Prefer 4–6 layers.

[Odysseus example](examples/positional/funnel.diagram.yaml), pinned to `2026-07-12`.

Adapted from diagram-design commit `b46c9701f035844a20b13ab0551315977188933b` under the module MIT notice. Brain-kit keeps its fonts, solid token paints, 9px floor and white print ground. The source spec remains authoritative; missing authored narrow placement selects the caption/summary and Open diagram viewer, never automatic reflow.

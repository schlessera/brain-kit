# Pyramid

Use `positional.pyramid.layers` in apex-to-base order. Each layer references a semantic node and may supply a positive value and side annotation. Values must be supplied for every layer or none, and increase toward the base. Widths preserve those quantitative ratios; names and node sublabels must fit the narrowest interior at the 9px floor. Prefer 4–6 layers.

[Odysseus example](examples/positional/pyramid.diagram.yaml), pinned to `2026-07-12`.

Adapted from diagram-design commit `b46c9701f035844a20b13ab0551315977188933b` under the module MIT notice. Brain-kit keeps its fonts, solid token paints, 9px floor and white print ground. The source spec remains authoritative; missing authored narrow placement selects the caption/summary and Open diagram viewer, never automatic reflow.

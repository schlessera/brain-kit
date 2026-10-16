# Venn

Use `positional.venn.sets` to reference semantic sets, optionally with relative weights, and `intersections` for inclusive shared regions. Prefer 2–3 circles. Centers and radii stay on the 4px grid; weighted areas are rounded only when relative area error stays within 5%, otherwise check refuses the misleading comparison. All circles share a genuine overlap. A label rectangle must fit inside every selected circle and stay clear of every stroke; small overlaps use a leader to an exterior callout instead. Set names and optional sublabels sit outside the circles. One intersection may be focal. Solid grounds, borders and labels replace upstream alpha tints.

[Odysseus example](examples/positional/venn.diagram.yaml), pinned to `2026-07-12`.

Adapted from diagram-design commit `b46c9701f035844a20b13ab0551315977188933b` under the module MIT notice. Brain-kit keeps its fonts, solid token paints, 9px floor and white print ground. The source spec remains authoritative; missing authored narrow placement selects the caption/summary and Open diagram viewer, never automatic reflow.

Use `positional.venn.intersections[].focal` for the one focal intersection. Common focal set IDs remain valid with a warning: they cannot identify an intersection and do not paint an amber set or advertise an unused focal legend.

Legacy sources without the typed block stay valid with a positional interpretation warning. Equal set areas are qualitative; author weights when the areas carry quantitative meaning.

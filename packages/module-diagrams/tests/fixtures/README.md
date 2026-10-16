# Geometry fixture provenance

These synthetic fixtures re-author applicable adversarial classes from the
MIT-licensed upstream pinned in `../../upstream.json`, specifically
`skills/diagram-design/scripts/test-verify-geometry.py` and the six rules in
`skills/diagram-design/references/primitives-core.md`. Attribution is in the
package LICENSE. All example content uses the Odysseus corpus.

| Upstream adversarial class | Neutral-tree proof |
| --- | --- |
| Diagonal and corner/border-riding connectors | orthogonal, small; actual port normals, corner distances and parsed M/L/A arcs |
| Forks sharing a port and trunks sharing a run | fan, trunk, closeParallel; coordinate fan formula and independent parallel separation |
| Perpendicular crossing | crossing; exactly one actual semicircle on the lower-priority edge |
| Mask placement, including a wide mask and translated panels | mask, vertical, panels; measured bounds, true gap and paint order |
| Intervening box | intervening, transit; reroute or explicit unavoidable dashed transit with visible-end label |

Raw SVG quote parsing, defs/use expansion and transform syntax are upstream
verifier-parser tests, outside a pure data-tree builder. The panel fixture
uses already-resolved global coordinates. No upstream HTML or personal data
is copied. The source fixtures are independent of the mathematical assertions.

Generated coverage includes 48 deterministic four-node graphs (at least 32
must produce geometry, and every successful output is checked), plus 12
translated instances each of true crossing, same-side fan, unavoidable transit
and vertical labels, all of which must succeed. Emitted paths are parsed
independently and sampled on their actual circular arcs, rather than trusting
the builder's radius and bridge metadata alone.

# Diagram spec v1, check, geometry and skin (additive, 0.44.0, #2089, #2090, #2093, #2097)

With `@schlessera/brain-module-diagrams` enabled, `brain diagram check
<file|-> --json` reads one standalone YAML document or exactly one Markdown
`diagram` fence. `-` reads stdin. A standalone file conventionally ends in
`.diagram.yaml`; Markdown outside the selected fence is ignored. Backtick and
tilde fences follow matching marker/length rules, including nested examples.
Multiple diagram fences and an unclosed diagram fence are errors. A standalone
mapping containing `schema_version` takes precedence, so literal descriptions
can themselves contain examples of fences.

The spec is data. YAML 1.2 core scalar types are accepted; duplicate keys,
unknown tags, aliases, multiple documents, invalid UTF-8 CLI input and input
over 1 MiB are refused. The command never evaluates, renders or writes content.

The authoritative structural schema is
[diagram-spec-v1.schema.json](diagram-spec-v1.schema.json), generated from the
module's exported `diagramSpecSchema`. `DiagramSpec` is its inferred type;
`checkDiagram(source)` returns the same validation result as the CLI.
`diagramSpecJsonSchema` is the generated structural schema. Runtime checks add
reference integrity, combined focal roles and geometry rules described below.

## Common grammar

Every object is strict: an unknown field is an error at that field's path.
Required top-level fields are `schema_version: 1`, `type`, `title` (1–60
characters), `desc` (nonempty text), `size`, `nodes` and `edges`. Optional fields
are `groups`, `focal`, `callouts`, `link` and `layouts`. Text fields other than title have
a 2048-character parse limit. All numbers are finite.

| Field | Shape |
| --- | --- |
| `size` | `doc-inline`, `doc-wide`, `slide-16x9`, `slide-4x3`, `social-og`, `social-square`, `print-a4-landscape`, `print-a3-landscape`, `print-letter-landscape`, or `fit` |
| Node | `id`, `label`; optional `sub`, `tag`, `role`, `link`; free-layout nodes also require `at` and `size` |
| `role` | `focal`, `default`, `store`, `external`, `input`, `optional`, or `boundary` |
| Node `at` | `[x, y]`, both nonnegative |
| Node `size` | `[width, height]`, both positive |
| Group | `id`, `label`, `members` (one or more distinct node IDs) |
| Edge | `from`, `to` (node or group IDs); optional `id`, `label`, `kind` |
| Edge `kind` | `primary`, `link`, `default`, or `async` |
| `focal` | Up to two element IDs; a named node, group or edge must exist |
| Callout | `target` (an existing element ID), `text` |
| `link` | Internal `[[wiki-link]]` string; available on the spec or a node |

IDs match `[a-z][a-z0-9-]*`, up to 80 characters, and are unique across nodes,
groups and named edges. References must resolve. Nodes, groups, group members
and callouts have a 1024-entry parse bound; edges have a 4096-entry parse bound.
These work bounds are distinct from the much smaller editorial budgets.

The discriminator `type` selects one common family grammar:

| Family | Types | Node geometry |
| --- | --- | --- |
| Free layout | `architecture`, `flowchart`, `state-machine`, `tree`, `er`, `dependency` | `at` and `size` required |
| Ordered axes | `sequence`, `swimlane`, `timeline`, `gantt` | `at` and `size` forbidden; order supplies position |
| Fixed layout | `quadrant`, `layer-stack`, `pyramid`, `funnel`, `loop`, `flywheel`, `venn` | `at` and `size` forbidden; the type supplies geometry |

This is the common grammar for those families. The free-layout client/static renderer is available; it does not claim
specialized participants/messages, lanes/steps, dated-event or type-specific
content fields. Those are separate additive family work. Other type names are
refused. After common semantic checks pass, free-layout validation also runs
the pure geometry builder with its default label metrics. Ordered-axis specs retain their common checks until their family builder ships. Fixed-family specs additionally accept the positional grammar below.

## Semantic checks and budgets

Free-layout node origins and dimensions must be multiples of 4px. Boxes may
touch at their boundaries but their interiors cannot overlap. A third distinct
focal element is an error, counting the union of `focal` IDs and nodes with
`role: focal`; spelling the same node in both counts once. A tree cannot
contain a directed cycle.

Editorial overruns are warnings and keep `valid: true` unless another error
exists. Defaults come from the pinned upstream method's `layout-budget.md`:
9 nodes, 12 edges, 2 callouts, and 14 Unicode code points per arrow label.
Tighter common per-type budgets also apply: 5 sequence nodes, 5 swimlane nodes,
8 ER nodes, 6 layer-stack nodes, 6 pyramid nodes, 3 Venn nodes, and 4 tree levels
(counting a root as level 1). Universal limits still apply to every type;
type-specific grammar budgets are added with those grammars. The validator
suggests splitting an over-budget diagram into overview and detail.

## Result envelope

All JSON results, including usage and input errors, have exactly these fields:

```json
{"schema_version":1,"valid":true,"type":"architecture","errors":[],"warnings":[]}
```

`schema_version` versions the result envelope independently of the input.
`type` is a supported type after structural validation, or `null` if parsing or
schema validation failed. Each finding has exactly `path`, `code`, `message`.
Paths use `$`, `.field`, `[index]`, and JSON-quoted brackets for unusual field
names. Findings are ordered deterministically by schema traversal, then
semantic traversal; warnings follow edge-label order, universal budgets,
per-type budgets, then tree depth. Callers should branch on codes and paths,
not prose or filesystem error text.

Error codes are `usage`, `input`, `parse`, `schema`, `unknown_field`,
`upgrade_required`, `duplicate_id`, `duplicate_reference`, `unknown_reference`,
`focal_count`, `tree_cycle`, `grid`, `overlap`, `unroutable`, `layout`,
`text_floor`, `contrast`, and `positional`. Warnings use `budget`; positional family guidance may also use `positional`.
A numeric input `schema_version` newer than 1 returns `upgrade_required` at
`$.schema_version` with an instruction to upgrade the diagrams module.

Exit 0 means no errors (warnings may exist); exit 1 means invalid input, usage
or an unreadable source. `--json` writes only the result on stdout. The core's
normal machine-output selection applies; `--human` selects readable findings.

## Pure free-layout geometry

`buildDiagram(spec, options?)` accepts a structurally and semantically valid
free-layout `DiagramSpec` and returns a `DiagramTree`, without DOM access,
rendering, I/O or source mutation. It parses the structural schema itself;
call `checkDiagram` for reference, grid, overlap and editorial validation.
Fixed-family specs use their deterministic positional builder described below; ordered-axis types are refused here. Repeated identical inputs and options produce
byte-identical serialized trees.

The tree contains `schema_version: 1`, `type`, `title`, `desc`, `viewBox`
(`x`, `y`, `width`, `height`) and ordered `elements`. Discriminated element
kinds are `group`, `connector`, `label-mask`, `edge-label` and `node`.
Groups derive a 16px padded member bound; nodes retain supplied coordinates,
sizes, labels and presentation metadata. Connectors identify the source edge
index and contain actual attachment ports, an orthogonal point list, an SVG
`M`/`L`/`A` path string, corner radius, crossing bridges, dashed state and
explicit hidden-transit node IDs. Unnamed connectors use `edge:<index>` IDs.
Masks carry their measured box, segment index, opaque flag and 8px gap;
edge labels carry text, measured box and font size. This is geometry data;
colors, strokes, markers, text rendering and accessibility belong to painters.
Paint order is groups, connectors, masks, labels, then nodes.

Routes use 8px circular elbows, perpendicular ports at least 8px from corners,
and evenly fanned same-side ports at `length * k / (count + 1)`. Port spacing
is at least 12px, or 8px on sides shorter than 48px. Parallel runs stay at least
12px apart. A perpendicular crossing has one 6px semicircular hop on the less
important edge: transit, then async, then default/link, then primary; ties put
the hop on the later edge. Bridge metadata and actual path commands agree.

Labels have opaque masks separated by 8px from their segment, beside vertical
runs. Masks remain clear of nodes and other masks, and preserve at least 8px
clearance from route polylines and conservative curve bounds. Optional
`labelFontSize` and `labelLineHeight` default to 9.5px and 12px. Both must be
finite, from 9px through 256px, with line height at least font size. Width is
`ceil((typeWidthBudget(text, "label", fontSize) + 8) / 4) * 4`; height is
`ceil((lineHeight + 4) / 4) * 4`. Painters must use compatible metrics or request
appropriate dimensions; this conservative model does not claim font shaping.

Nonendpoint boxes are routing obstacles. A direct aligned path through a box
is allowed only after clear routing fails, is dashed, names each hidden node
in `transit`, and places any label at its visible source end. The path still
ends at the actual destination. Earlier connectors alone cannot justify
hidden transit. Routing is deterministic and bounded (20,000 candidates or
visibility vertices, 100,000 search steps); it may refuse crowded layouts
rather than claim a complete global routing solver. A refusal throws
`DiagramGeometryError` with `findings` (`path`, `code: unroutable`, `message`);
edge findings name the edge. The checker includes those findings at the end
of its errors and returns exit 1. Invalid metric options throw an error.

Canvas dimensions are fixed for named presets: doc-inline 960×600, doc-wide
and slide-16x9 1280×720, slide-4x3 1024×768, social-og 1200×632,
social-square 1080×1080, print-a4-landscape 1120×792,
print-a3-landscape 1584×1120 and print-letter-landscape 1056×816.
`fit` uses node extents plus 24px, with a 96px minimum per axis. Routing never
moves nodes or invents family-specific layout.

## Authored narrow placement and paint

An optional strict `layouts: { narrow: { width: 320, height, nodes } }` supplies
explicit free-layout placement. `height` is positive, at most 16384 and on
the 4px grid. Each node is exactly `{id, at: [x,y], size: [width,height]}`.
Every semantic node ID must occur exactly once, with no extra IDs, no overlap
and all bounds/grid constraints satisfied. Semantic labels, groups and edges
remain solely in the original spec. Ordered/fixed types refuse this placement.
Missing narrow placement is valid and preserves existing checker behavior.

`diagramLayout(spec, name?)` returns original default placement or applies
`narrow` positions. `buildDiagramLayout(spec, name?)` validates authored
placement and produces the neutral geometry tree, with an exact 320×height
narrow viewBox. Groups, routes and label masks must fit that frame. A missing
requested placement throws; consumers show caption, summary and Open diagram
instead of shrinking or scrolling an inline figure. These helpers do not draw
or choose the UI fallback.

`DIAGRAM_TOKEN_CSS` and `DIAGRAM_PALETTE` are generated from the kit's canonical
stylesheet. The CSS scopes to `.bk-diagram`, supports light-dark pairs and
explicit data themes, and overrides screen theme selectors under print media.
`DIAGRAM_TYPE` defines the approved title/name/sub/label fonts and metrics.
`typeWidthBudget` budgets every Unicode code point and tracking;
`fitDiagramText(text, role, availableWidth)` uses the standard size or fits down
to 9px, and throws rather than clipping below that floor. Node text has 8px
horizontal padding per side, 16px total vertical padding and 12px minimum
line boxes, counting the generated role tag. Explicit tags replace that tag.
`checkDiagramSkin` and the main checker refuse impossible node text and every
below-bar information/text paint pair in light, dark and print (3:1 strokes,
4.5:1 text). `contrastRatio` accepts opaque canonical six-digit hex colors.

`diagramNodePaint(role, focal?, inGroup?)` supplies token-only fills, strokes,
text/sub colors, widths, dashes, radii and redundant role tags.
`diagramEdgePaint(kind, transit?)` supplies the semantic stroke, width,
dash, line cap and arrowhead shape; callers retain original edge kind through
geometry. `return` reserves the approved dashed treatment for axis families.
`diagramInkRamp` returns solid color-mix steps, without alpha ink.

## Renderer entries

The configured module declares fence `diagram`, extension `.diagram.yaml`,
client entry `@schlessera/brain-module-diagrams/ui` and static entry
`@schlessera/brain-module-diagrams/render`. These remain trusted, build-bundled
entries under the content-renderer contract. `diagramsContentPack` and
`diagramsStaticPack` share the same geometry and generated light/dark/print
tokens; static `toStatic(source, { theme, path? })` needs no browser and returns
scriptless, resource-free SVG. Invalid sources throw for the seam's code fallback.

Static figures carry ID-free accessible names/descriptions so multiple and
repeated figures can safely share a document. Client linked nodes use the app's
wiki-link resolver and focusable SVG groups; static output does not navigate.
Authored narrow placement is selected only when its native frame fits the
container. Missing or non-fitting placement uses the semantic summary and Open
diagram control, with a readable dedicated viewer, rather than inline scaling.

The shared SVG model includes boundary-heading knockouts and a legend for the
edge encodings and applicable focal/store roles. Legend cells wrap from their
shared type budgets. Default `size: fit` reserves presentation-only footer space
without moving content; authored narrow dimensions stay exact. A fixed canvas
that cannot fit the readable footer is refused with an explanation rather than
clipping or shrinking the diagram.

## Positional families (additive, #2097)

Fixed families optionally accept a strict `positional` object. Its only supplied
member must match the type; all referenced common node IDs must occur exactly
once. Omitting it preserves previously accepted v1 forms and supplies the
family's deterministic default order. `positionalSchema` and `PositionalSpec`
export this additive input shape. Named canvas dimensions are unchanged; `fit`
uses the 960×600 positional default. No automatic narrow placement is inferred;
fixed types retain the caption/summary and readable viewer fallback.

| Type | Optional member and fields |
| --- | --- |
| `quadrant` | `quadrant: {xAxis: {negative, positive}, yAxis: {negative, positive}, points: [{node, x, y}]}`; finite normalized coordinates −1…1, neither coordinate zero; one-word axis tips |
| `layer-stack` | `stack: {order?, direction?: "up" | "down", directionLabel?}`; equal bands and consecutive layer indices |
| `pyramid`, `funnel` | `pyramid: {layers: [{node, value?, annotation?}]}`; all values supplied or all omitted, positive and monotonic in the type's orientation |
| `loop`, `flywheel` | `loop: {hub, stations, spokeLabels?: [{station, text}]}`; exactly one disjoint hub, clockwise stations, at most one focal station |
| `venn` | `venn: {sets: [{node, weight?}], intersections?: [{members, label, focal?}]}`; distinct declared intersection members, at most one focal region |

Every nested object is strict; list parse bounds are 1024, text 2048 and common
ID limits apply. Intersection membership contains 2–3 IDs. Geometry failures
and structural ambiguity produce `positional` errors. Editorial budgets warn:
quadrant up to 12 items, layers/pyramid/funnel 4–6, loop/flywheel 5–8 stations
plus a hub, Venn 2–3 sets. The loop station budget adapts upstream's hard budget
to #2097's explicit warning acceptance; valid hub/reference invariants remain
errors. Existing universal warnings still apply.

Pyramids have a tapered point-up apex; funnels narrow downward. Quantitative
layer boundary widths are proportional to the supplied values. Labels and
sublabels fit the width available across their full trapezoid text band.
Loop paths use the grammar's true circular-arc exception, a common radius,
clockwise tangential heads and dashed radial returns into the hub. Opaque spoke
label masks keep 8px clearance from actual paths and other content.
Venn circle centers/radii stay on the 4px grid. Weighted areas retain relative
ratios within 5%; comparisons that cannot meet that tolerance on the grid are
refused rather than drawn misleadingly. Circles share a real overlap; an
intersection box lies fully inside its selected circles and clear of strokes,
or uses an exterior leader callout for a small overlap. Common focal set IDs remain valid with an actionable `positional` warning; only an explicit focal intersection paints the Venn focal treatment and its legend key. A non-fitting readable
callout asks for a taller canvas. No alpha blending conveys intersection data.

The existing `DiagramTree` adds a closed `kind: "shape"` variant exported as
`DiagramShape`, `DiagramShapeBase` and `DiagramShapePaint`. Generated concrete
shapes are line, rectangle, circle, polygon, path or text with numeric bounds,
symbolic paints/type roles, optional generated arrowhead and trusted semantic
node/edge identity. There is no raw input SVG, arbitrary attributes, CSS or
registration interface. Client and static painters consume the same tree and
shared role paints; linked names and bodies share one focusable semantic group.
All generated coordinates are finite, scene bounds reserve stroke/arrowhead
and legend space, and fitted/displayed type retains the 9px floor.

The seven shipped examples under
`packages/module-diagrams/skills/diagram/references/examples/positional/` are
the sources for the type reference pages and browser visual baselines.

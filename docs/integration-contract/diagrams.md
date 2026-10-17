# Diagram spec v1, check, geometry and skin (additive, 0.44.0, #2089, #2090, #2093, #2096, #2097, #2099)

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
are `id`, `groups`, `focal`, `callouts`, `link` and `layouts`. Text fields other than title have
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

The common grammar remains accepted. Axis types add an optional strict `axis`
object with a matching `kind`; its fields are described below. Free-layout
rendering and the axis family are available. Fixed families add the optional positional grammar described below.

## Ordered axis grammar

The optional `axis` object never permits `at` or raw SVG/style data. Existing
v1 `nodes`/`edges` are retained. Nodes supply labels, optional wiki-links and
optional explicitly authored participant tags; tags are never inferred for a
sequence. Every object is strict and references must resolve.

| `axis.kind` | Fields |
| --- | --- |
| `sequence` | Ordered `messages`: `{id, from, to, label, kind?, focal?, note?}`. Kinds are `message`, `return`, `async`. Optional `fragments`: `{kind, from, to, guard, elseAt?, elseGuard?}`; kinds are `alt`, `opt`, `loop`, and message indices are zero-based inclusive. An alt has exactly two nonempty regions separated by `elseAt`. Other operators and partially overlapping ranges refuse. |
| `swimlane` | Ordered `lanes: [{id,label}]`, ordered `steps: [{node,lane}]`. Each node has exactly one declared lane owner. Existing edges are handoffs. |
| `timeline` | Chronological `events: [{node,date}]`, with real ISO calendar dates. |
| `gantt` | Ordered `tasks: [{node,start,end,phase?}]`, optional `phases: [{id,label}]` and explicit `marker` date. End cannot precede start. Phase references resolve. Dependency arrows are outside this v1 grammar. |

Dates are authored `YYYY-MM-DD` values, never wall-clock defaults. Timeline
positions and Gantt durations are proportional to real date differences.
An original axis spec without family data still draws from its node/edge order;
a dated type with no dates labels that absence rather than inventing dates.
Messages have a 4096-entry parse bound; the other family arrays have a
1024-entry parse bound. These are work limits, not editorial budgets.

Axis validation adds `axis` error findings and deterministic `budget` warnings.
Sequence defaults are five lifelines, twelve messages, two notes, one fragment
(or two if both are single-region opt/loop), and one nesting level. An alt has
two regions. A third focal message refuses. Swimlanes warn above five lanes;
Gantt warns above twelve tasks or five parallel tasks per phase. Universal
node/edge/focal/callout budgets still apply, and a first excess editorial item
warns rather than invalidating otherwise valid data.

The family builder produces closed `shape` geometry: lines, rectangles,
circles, polygons, generated paths and text with explicit numeric bounds,
symbolic paint/type roles and optional generated arrow geometry. This is a
finite concrete representation, not raw attributes or an extension registry.
Client and static paths consume the same tree and shared shape painter.

Sequence presentation follows the approved #2092 brief: solid lifelines,
outlined activation bars, open message/return chevrons, dotted async, dashed
returns and a filled amber head only on a focal message. Notes use 11px sans.
Participant tags are optional authored data and expand headers to 52px.
Normal 12px names and 9.5px labels are preserved at 320px with at least a 64px
participant pitch; long names, labels, self-messages and notes can refuse the
narrow presentation. The app then shows its caption/summary and Open diagram,
with readable native-scale content in the dedicated viewer. Other axis types
also fall back when their full readable canvas cannot fit inline.

## Semantic checks and budgets

Free-layout node origins and dimensions must be multiples of 4px. Boxes may
touch at their boundaries but their interiors cannot overlap. A third distinct
focal element is an error, counting the union of `focal` IDs and nodes with
`role: focal`; spelling the same node in both counts once. A tree cannot
contain a directed cycle.

Editorial overruns are warnings and keep `valid: true` unless another error
exists. Defaults come from the pinned upstream method's `layout-budget.md`:
9 nodes, 12 edges, 2 callouts, and 14 Unicode code points per arrow label.
Tighter common per-type budgets also apply: 5 sequence participants, 5 legacy swimlane items (the specialized grammar counts lanes instead),
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
semantic traversal; warnings follow containment budgets (when present), edge-label order, universal
budgets, common per-type budgets, tree depth/breadth, then family advisories. Callers should branch on codes and paths,
not prose or filesystem error text.

Error codes are `usage`, `input`, `parse`, `schema`, `unknown_field`,
`upgrade_required`, `duplicate_id`, `duplicate_reference`, `unknown_reference`,
`focal_count`, `tree_cycle`, `grid`, `overlap`, `unroutable`, `layout`,
`text_floor`, `contrast`, `axis`, and `positional`. Common editorial warnings use
`budget`; family advisories (including positional guidance) are listed with their
grammars below.
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
Axis and fixed-family types dispatch to their deterministic family builders. Repeated identical inputs and options produce
byte-identical serialized trees.

The tree contains `schema_version: 1`, `type`, `title`, `desc`, `viewBox`
(`x`, `y`, `width`, `height`) and ordered `elements`. Discriminated element
kinds are `group`, `connector`, `label-mask`, `edge-label`, `node` and the closed generated `shape`.
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
`fit` uses node extents plus 24px, with a 96px minimum per axis. Optional
architecture containment also includes authored scope bounds; dependency cycles
reserve their outside lane plus a margin. Routing never
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
family's deterministic legacy interpretation, with an actionable `positional` warning. A legacy quadrant lists semantic items with POSITIONS AND AXES NOT PROVIDED instead of invented scored coordinates/dimensions. Layers use input order; pyramids/funnels use qualitative widening/narrowing widths, loops take the first node as the hub with remaining input-order stations, and Venn uses equal qualitative set areas. Author the matching typed namespace to make those meanings explicit. `positionalSchema` and `PositionalSpec`
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
The [shipped axis examples](../../packages/module-diagrams/skills/diagram/references/examples/)
are the canonical sequence, swimlane, timeline and Gantt specs used by the
family references, real CLI tests and browser visual fixtures.

## Node-link family additions (v1, additive minor)

Existing common v1 figures remain accepted. Architecture optionally adds
`containment.scopes` with strict `{id,label,kind: admin|traffic,parent?,at,size}`
bounds; its nodes optionally add `kind: compute|endpoint|managed`, `parent`,
`target`, and edges `peering`. With containment present these fields describe the
actual innermost geometry and provider-neutral hierarchy; invalid parents,
placement, endpoint targets or peering fail with `containment`.

Flowchart nodes add optional `shape: start|end|step|decision|merge`; state-machine
nodes add `shape: state|initial|final`. A decision's exits require labels
(`decision_label`); initial/final direction errors use `initial_incoming` and
`final_outgoing`; mismatched dot boundary boxes use `marker_size`. A tree with optional `hierarchy: true` cannot have multiple parents (`tree_parent`);
legacy generic shared-parent sources remain valid with that advisory warning.
Optional `direction: down|right` selects hierarchical bottom/top or right/left
attachments; children must be authored beyond parents (`tree_direction`).
ER nodes add optional `fields: [{name,type?,key?: PK|FK}]`; relationships add
paired `fromCardinality` / `toCardinality`, each one of `1`, `N`, `0..1`, `1..*`
(`cardinality_pair`). Dependency nodes add optional integer `rank` (0–1024),
edges add optional `cycle`; backward rank edges require a named highlighted cycle
(`dependency_rank`, `cycle_label`). Unknown keys remain errors per concrete type.

Additional editorial warnings use `budget` for 3 flat architecture zones,
2 containment admin bands / 4 traffic scopes / 8 nodes, 3 decision exits,
twice-state-box-count transitions (excluding markers), 5 tree items across a whole level, 4 dependency ranks and
1 highlighted dependency cycle. `state_label`, `prefer_tree`, `rank_missing`, `rank_alignment`, `rank_spacing`,
`unmarked_cycle`, and `accent_budget`
are actionable advisory findings. All warnings preserve content and validity in
the absence of another error; focal hard maximum remains two.

Neutral node metadata gains shape/fields/rank/computed fan-in and containment
kind/parent/target. Groups may carry authored scope kind/parent bounds. Trees
optionally carry `grammar: architecture-containment`; the new `cardinality`
element carries edge/end/text and its box. These generated primitives paint
identically in client/static entries. Scope bounds render directly as rects
with metadata; admin bands use 4px corners, a dashed outline and a 24px header,
traffic boxes use 8px corners and a solid outline. No transform or automatic placement is introduced. Nonrectangular
terminals/diamonds/dots use distinct cardinal ports at their true boundary.
Circular dots have no rectangle corners; their exact diameter bounds and centred
cardinal attachment replace rectangle corner-clearance checks.
ER relationships and tree branches omit arrow heads. Every dependency node shows
its computed fan-in badge; named canvases refuse a cycle that cannot fit clear of
the frame, while fit bounds include its outside lane and margin. The `diagramNodeLines` skin helper is internal
to validation/painters and is not an additional public entry export. Type references and shared
standalone examples ship under `skills/diagram/references/`.

## Export, derived pairs and hygiene (additive, #2099)

An optional top-level `id` uses the common 80-character ID grammar. It names a
Markdown fence's derived pair and is independent of its node/edge IDs.

`brain diagram export <file|-> [--theme light|dark|print] [--format svg|png|pdf]
[--out path] [--json]` validates the same spec, defaults to print/SVG, and writes
an artifact inside the brain. File defaults replace `.diagram.yaml` (or the
last extension) with `.theme.format`; stdin defaults to a unique ignored
scratch file. An explicit output must have the matching extension. Sources,
symlinks, non-files and paths outside the brain cannot be replaced. SVG export
uses the static renderer's geometry, resolves the selected canonical palette
and opaque ink ramps, and contains no dynamic `var(` paint. Authored text is
escaped without changing its parsed SVG text. Exported SVG and built pairs embed the four painted locked normal kit faces
as data fonts with their package OFL notices; no host font or external font
request supplies these roles. SVG needs no browser. PNG/PDF
use the existing optional `@schlessera/brain-render-puppeteer` package and its
Chrome discovery, sandbox environment interpretation, offline request policy
and lifecycle. No API key is needed.

The export JSON envelope is exactly:

```json
{"schema_version":1,"ok":true,"input":"release.diagram.yaml","output":"release.print.svg","format":"svg","theme":"print","bytes":123,"warnings":[],"errors":[]}
```

`bytes` is the actual UTF-8 or binary output size. Failure leaves `output: null`
and `bytes: 0`; validation findings retain their codes and paths, while usage,
I/O and rendering failures use `export`. Every artifact finding is exactly
`{code,path,message}`. Unknown theme/format values fail; the error envelope
retains print/SVG defaults until both selections validate. Exit status is 0
only for `ok: true`. Human output prints the resulting relative path.

`brain diagram build <markdown file> [--json]` parses actual GFM diagram fences,
including list/quote containers, without treating fenced Markdown examples as
diagrams. Each valid fence with an `id` produces `id.light.svg` and
`id.dark.svg` beside the source, plus an escaped `<picture>` snippet on stdout.
Unnamed fences emit `missing_id` warnings and produce no pair. Valid checker
warnings retain source/fence locations. Repeated IDs fail. Every planned spec,
output path and existing output's ownership is checked before writing any
pair. A manual SVG or a pair owned by another Markdown file refuses, so two
source files with the same ID cannot silently replace one another's diagrams.
Markdown is never rewritten or committed.

The build envelope is exactly:

```json
{"schema_version":1,"ok":true,"input":"dispatch.md","figures":[{"id":"release","light":"release.light.svg","dark":"release.dark.svg","picture":"<picture>…</picture>","source_sha256":"…"}],"written":["release.light.svg","release.dark.svg"],"warnings":[],"errors":[]}
```

`figures` contains only complete pairs. `written` records each successful
atomic artifact write, including a first file if a later write fails;
`ok: false` and a `build` error then report the partial result honestly.
Generated SVG metadata contains only a finite generator identity, bounded ID,
SHA-256 of the GFM fence payload and SHA-256 of the canonical relative source
path. It contains no absolute machine path. Unrelated Markdown prose edits do
not invalidate the fence's derived pair; payload changes, missing partners or
ownership mismatches do.

`brain audit` reports `diagram-module` when an indexed, non-archived Markdown
file contains real diagram fences and no active diagrams module is configured
(including a dormant module). Core detects the syntax without importing absent
or content-owned module code. The enabled module's existing hygiene hook
reports `diagram-invalid` for invalid specs/repeated IDs and `diagram-stale`
for an existing derived pair whose identity is stale, incomplete or unrelated.
A pair that was never built is optional and produces no stale finding.
Unreadable/out-of-root/over-1-MiB source files report `diagram-source` warnings
(the missing-module detector requires indexed diagram evidence on read failure).
Symlink or nonregular derived entries are stale, never treated as absent or
opened as ordinary files. Inspection refuses source FIFOs/special files too;
derived files have an 8-MiB inspection bound. These checks inspect current
Markdown and regenerate from its source, with no authoritative build database.

The concrete `@schlessera/brain/module` helpers `markdownFences(text)` and
`renderHtmlArtifact({html,format,width?})` share core's existing parser and
optional renderer. Fence records are `{language,meta,value,line,start,end}`;
line is one-based and offsets delimit the original GFM code block. The artifact
helper accepts only PNG/PDF, denies external hosts, and always shuts its
renderer down after success or failure. It reuses canonical sandbox environment
aliases and does not introduce a renderer registration interface.

## Common annotation placement (#2242)

Callouts additionally accept optional `side: below|above|right|left`. It is a
preference: the requested side is tried first, then the remaining sides in
below, above, right, left order. No hint preserves that default order. Hints
never move semantic geometry or allow an annotation to cover nodes or masks.

The maintainer-approved N2 compatibility change adds `callout_room` at
`$.callouts[index]` when a fixed named canvas has neither a collision-free
readable note placement nor enough space for a notes band. Reserve annotation
space or migrate the source to `size: fit`; named canvases do not grow. This
is a breaking input-validation change authorized on #2242 and ships in a
minor before 1.0. It does not authorize rejecting previously valid `fit`
sources. Notes use Plus Jakarta Sans 11px/500 with authored capitalization,
wrapping rather than truncation or reduced text size.

# The homecoming relay — revised design artifacts

Design revision for [#2091](https://github.com/schlessera/brain-kit/issues/2091), incorporating D1–D5 and C1. These are authored visual-review artifacts. They do not implement tokens, the diagram schema, a renderer or viewer interactions. The issue owns the final visual ruling.

## Renderings

| Composition | Light | Dark | Print |
| --- | --- | --- | --- |
| Desktop, 720 × 480 | [PNG](relay-desktop-light.png) · [SVG](relay-desktop-light.svg) | [PNG](relay-desktop-dark.png) · [SVG](relay-desktop-dark.svg) | [PNG](relay-desktop-print.png) · [SVG](relay-desktop-print.svg) |
| Authored narrow, 320 × 1088 | [PNG](relay-narrow-light.png) · [SVG](relay-narrow-light.svg) | [PNG](relay-narrow-dark.png) · [SVG](relay-narrow-dark.svg) | [PNG](relay-narrow-print.png) · [SVG](relay-narrow-print.svg) |

[Focal hover/focus illustration](relay-desktop-focus-light.png) · [SVG](relay-desktop-focus-light.svg). The ring and thicker incident paths carry focus without a color-only change.

[Absent narrow layout, light](absent-narrow-light.png) · [dark](absent-narrow-dark.png). The upper card is the inline phone fallback: caption, semantic summary and a 44px “Open diagram” control. The separate lower panel illustrates the dedicated viewer at 100%, with explicit pan/zoom rather than shrinking text. It is an illustration, not an implemented interaction.

The source model has eight nodes, seven directed relationships and one focal node. `source-watch` is a separate agent in THE BRAIN; News from Sparta → source-watch → inbox is explicit. Penelope remains in ITHACA, one hour ahead of 06:40 Ogygia on `2026-07-12`.

## Paint mapping

Values are light / dark / print. All colors are solid. The SVGs use named custom properties; the embedded values are this design’s review palette, not the generated production token block. D1–D3 remain downstream implementation work.

| Token | Light | Dark | Print | Role |
| --- | --- | --- | --- | --- |
| `--bk-diagram-bg` | #f8f5ef | #141619 | #ffffff | Figure ground, outside external nodes, matching masks |
| `--bk-diagram-node` | #fffefa | #1e2128 | #ffffff | Input/default/store ground |
| `--bk-diagram-cluster` | #ece7dc | #0c0e12 | #ffffff | Group ground; in-group external node ground; matching masks |
| `--bk-diagram-line` | #5f584c | #9a96a1 | #5f584c | Ordinary/store/async strokes |
| `--bk-diagram-cluster-border` | #847c6f | #6b6873 | #847c6f | Information-bearing group border (D1) |
| `--bk-diagram-text` | #231f1a | #e8e4df | #231f1a | Names, primary strokes/labels, focal sublabel |
| `--bk-color-ink-mute` | #5f584c | #9a96a1 | #5f584c | Non-focal sublabels, tags, group/edge/legend labels |
| `--bk-diagram-focal-tint` | #fbf1e0 | #3d352c | #ffffff | Focal ground (D3) |
| `--bk-amber-ink` | #7f4c08 | #e09f3e | #7f4c08 | Focal outline and role tag |
| `--bk-blue-ink` | #1a5c7f | #67b8e3 | #1a5c7f | Link stroke, hollow arrowhead and label |
| `--bk-color-line` | #ddd6c7 | #1f2229 | #cbc3b2 | Decorative screen frame and legend divider |
| `--bk-focus-ring` | #231f1a | #e8e4df | #231f1a | Focus ring |

The screenshot shell uses `--bk-diagram-cluster` around the figure and the same diagram tokens for its fallback card, text and controls. The tiny external-link glyph uses blue ink. The decorative divider/frame is not relied on to communicate grouping or state. Print omits the outer frame and uses white for all grounds.

| Foreground / ground | Light | Dark | Print | Minimum |
| --- | --- | --- | --- | --- |
| `--bk-focus-ring` / `--bk-diagram-cluster` | 13.28:1 | 15.26:1 | 16.38:1 | 3:1 |
| `--bk-diagram-cluster-border` / `--bk-diagram-cluster` | 3.34:1 | 3.54:1 | 4.12:1 | 3:1 |
| `--bk-diagram-cluster-border` / `--bk-diagram-bg` | 3.79:1 | 3.33:1 | 4.12:1 | 3:1 |
| `--bk-diagram-line` / `--bk-diagram-node` | 6.97:1 | 5.56:1 | 7.03:1 | 3:1 |
| `--bk-diagram-line` / `--bk-diagram-cluster` | 5.7:1 | 6.67:1 | 7.03:1 | 3:1 |
| `--bk-diagram-line` / `--bk-diagram-bg` | 6.46:1 | 6.26:1 | 7.03:1 | 3:1 |
| `--bk-diagram-text` / `--bk-diagram-node` | 16.23:1 | 12.73:1 | 16.38:1 | 4.5:1 |
| `--bk-diagram-text` / `--bk-diagram-bg` | 15.05:1 | 14.32:1 | 16.38:1 | 4.5:1 |
| `--bk-diagram-text` / `--bk-diagram-cluster` | 13.28:1 | 15.26:1 | 16.38:1 | 4.5:1 |
| `--bk-diagram-text` / `--bk-diagram-focal-tint` | 14.63:1 | 9.51:1 | 16.38:1 | 4.5:1 |
| `--bk-color-ink-mute` / `--bk-diagram-node` | 6.97:1 | 5.56:1 | 7.03:1 | 4.5:1 |
| `--bk-color-ink-mute` / `--bk-diagram-cluster` | 5.7:1 | 6.67:1 | 7.03:1 | 4.5:1 |
| `--bk-color-ink-mute` / `--bk-diagram-bg` | 6.46:1 | 6.26:1 | 7.03:1 | 4.5:1 |
| `--bk-amber-ink` / `--bk-diagram-focal-tint` | 6.38:1 | 5.27:1 | 7.14:1 | 4.5:1 |
| `--bk-blue-ink` / `--bk-diagram-bg` | 6.7:1 | 8.24:1 | 7.29:1 | 4.5:1 |
| `--bk-blue-ink` / `--bk-diagram-cluster` | 5.91:1 | 8.78:1 | 7.29:1 | 4.5:1 |

**Narrow accessibility correction proposed for final visual review:** the old muted focal sublabel pair `#9a96a1` on dark focal `#3d352c` measures **4.16:1**, below the 4.5:1 text floor. This revision uses existing `--bk-diagram-text` for the focal sublabel in every theme: light `#231f1a` / `#fbf1e0` **14.63:1**, dark `#e8e4df` / `#3d352c` **9.51:1**, print `#231f1a` / `#ffffff` **16.38:1**. This changes only that text-role assignment and adds no token. Final approval must include this visible correction.

## Type, roles and geometry

| Role | Family | Size | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Caption title | DM Serif Text | 18px | 400 | 0 |
| Node name | Plus Jakarta Sans | 12px | 600 | 0 |
| Sublabel | JetBrains Mono | 10px | 400 | 0 |
| Role/group/edge/legend/eyebrow | JetBrains Mono | 9.5px | 600 | 0.09em, uppercase |

Nodes use chip radius 5px; group boundaries and screen frame use inset radius 8px. A 2px focus ring has radius 9px at a 4px offset. Ordinary strokes are 1px, primary/async 1.5px and focal/focused paths 2px. Elbows use radius 8px. Default/async heads are open chevrons, primary is a filled triangle and link is hollow. Async is dotted `1.5 3.5` with round caps; return is dashed `6 4` across types, as selected by C1. This architecture contains no return edge.

Input and default agents use diagram-node, an ordinary outline and explicit INPUT/AGENT tags. Stores add the straight lid line and STORE tag. External nodes remain flush with their local ground and have EXTERNAL tags. Focal uses its solid named tint, 2px amber outline and AGENT tag. The existing optional treatment remains a node-ground box with `4 3` dashed line and OPTIONAL tag; a boundary uses an unwashed ground with a dashed `4 3` diagram-line outline, inset radius and explicit label. Neither is added to this example merely to demonstrate a role.

The legend repeats visual encodings, rather than every edge’s content. Structural positions/sizes lie on the 4px grid. All routes are orthogonal; multi-attachment sides fan evenly; labels sit on opaque matching-ground masks beside their segments, with 6–10px stroke clearance. The two compositions have no route crossings or shared parallel strokes, so no bridge is needed here. Downstream routing must still construct bridges for crossing diagrams. No route passes behind a non-endpoint node.

## Authored narrow placement and validation

`composition.json` separates stable semantic IDs, relationships and groups from two explicit layout tables. The narrow table is drawn independently at 320px and preserves every semantic ID/edge/group; it is not a scaled desktop figure or automatic reflow. This JSON is an artifact authoring model, not a proposed public schema. The downstream spec must express optional named narrow placement without duplicating semantic nodes/relationships; #2093 must consume the approved representation rather than treating these SVG coordinates as runtime input.

Validate a supplied narrow layout for complete/exact semantic node coverage, preserved edge endpoints/groups, finite bounded coordinates, the structural grid, fit/no overlap and a rendered text floor of 9px. Validate routes/masks/attach points from the same semantic model. Missing narrow placement is valid. On phones it selects the caption/summary/Open diagram fallback; never an inline scrolling or shrunken figure. The viewer preserves text at readable size and exposes explicit navigation.

## Departures and evidence

The plan’s basic token mapping holds, with the already selected shared dark border (D1), white print group ground (D2), named solid focal tint (D3), explicit eighth source-watch node (D4), optional authored narrow layout and absent-layout fallback (D5), and dotted async/dashed return (C1). Mermaid’s changed dark borders and white print groups require regression review during implementation.

Against upstream’s skin: use kit fonts; raise 7–8px labels to 9.5px and sublabels to 10px; replace alpha role fills with named solid grounds and shape/tag distinctions; use 5/8px kit radii and minimum 1px strokes for printer reliability; distinguish arrowheads by shape; frame screen diagrams but leave print white and unframed. Amber remains appropriate as the single focal treatment, with an AGENT tag and stronger outline carrying the same distinction in monochrome. The focal sublabel correction above is the only additional role-paint proposal.

The generator checks semantic identity, grid, orthogonal segments, no transit behind boxes and label-mask/node separation; `validation.json` records those results. `contrast.json` records every information/text pair tested. `browser-validation.json` records offline font loading, actual text bounds, eight nodes/seven edges, no page overflow, rendered widths of exactly 720px or 320px and a measured 9.5px minimum across all six theme/layout captures. The capture harness embeds checksum-verified fonts from the repository font lock and blocks browser network requests. SVG sources carry title/description and no script/external resource; standalone SVG font fallback may differ from the PNG’s pinned kit fonts.

Visual inspection covered all themes, both authored layouts, the focal illustration and both fallback illustrations. This is agent QA; the issue explicitly reserves final composition approval for the maintainer.

## Reproduce the review artifacts

Run `python3 docs/assets/diagrams-2091/build.py` from the repo root. For matching PNGs, populate a font cache with the checksum-verified assets from `scripts/captures/font-lock.json`, then run `node docs/assets/diagrams-2091/render.mjs <font-cache> <review-output-directory>` with Playwright and Chromium available. The harness creates only design captures and measurements; it does not claim interactive viewer coverage.

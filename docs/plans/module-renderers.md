# Module renderers and the diagrams module

The design for [the module-renderers decision](../decisions/module-renderers.md):
a content-renderer seam that modules contribute to, Mermaid moved onto it, and
a diagrams module that draws editorial figures in the brain-kit design system.
It spans `ui-sdk`, `core`, `ui-react`, `ui-server`, `render-template`, a new
module package and the hosting template's build, and its units have an order
(see "Order"). The work is tracked in
[one epic](https://github.com/schlessera/brain-kit/issues/2079). This file holds the shape the
tasks share, not their progress.

## The seam

A **content renderer** claims fence languages and file extensions. It is
declared once by a module and implemented by two entry points:

| Part | Lives in | Runs in | Does |
| --- | --- | --- | --- |
| Declaration | the module manifest, `renderers` key | core's module loader | Names fence languages, file extensions, and the two entry specifiers. Validated `.strict()` like every contribution (`export interface ModuleContribution`, `packages/core/src/lib/module-types.ts:136-164`). |
| Client entry | `<module>/ui` export | the PWA, registered at build time | A React component `({ source, path?, mode, theme }) → element`, where `mode` is `chat`, `file` or `share`. Built from ui-kit pieces and public entry points only. |
| Static entry | `<module>/render` export | `brain render`, `/api/render`, the client share path | `toStatic(source, { theme, path? }) → Promise<string>` returning HTML/SVG with no script and no external resource. It declares `needsBrowser`: Mermaid's static step needs a DOM, so it runs on the client before a share, as today. The diagrams module's does not. |

The client registry mirrors the tool-renderer one (`export function registerToolRenderers`,
`packages/ui-sdk/src/client/renderers.ts:171`) and is fed the same way, by the
build (`export function registerBuiltinRenderers`, `packages/ui-react/src/components/chat/renderers/index.ts:20-25`).
Dispatch order: an exact fence language or extension match from a configured
module, then the built-in code view.

Failure handling:

- A pack the build lacks renders the code view with a "renderer not bundled"
  note.
- A throwing pack renders the code view for that block only.
- A static step that throws makes the export keep the code block and report a
  lint finding.

Version skew: the server lists, per configured module, the renderers it
declares and the module version. The client compares that with its bundled
packs.

### The theme contract

Every pack implements `light`, `dark` and `print`. Callers choose the theme by
surface, never by pack:

| Surface | Theme |
| --- | --- |
| Chat, file viewer | The app's resolved `[data-theme]`, live |
| Browser print of any app page | `print` (the pack's print block, or the inline element's print values) |
| Share as PNG or PDF, `/api/render`, `brain render` | `print` |
| `brain diagram export --theme …`, `brain diagram build` | The theme named, explicitly |

Print means:
- a white ground matching the document shell (`--doc-paper: #ffffff` in
  render-template)
- print token values
- no washes or translucent fills
- borders and labels carrying structure, so grayscale output keeps its meaning
- no script and no external resource in static output

`@schlessera/brain-ui-sdk` ships `contentRendererConformance(pack)`, which
renders a pack's fixtures in all three themes and asserts:
- every theme renders
- the print ground is the document paper
- no colour literal sits outside the token block
- no alpha fill appears in print
- static output carries no script or network resource

Every first-party pack runs it in CI.

## The diagram spec

```yaml
# a ```diagram fence
schema_version: 1
type: architecture          # one of the shipped type grammars
title: The homecoming relay  # <title>, 60 characters or fewer
desc: How word of the raft reaches Ithaca.   # <desc>, one sentence about content
size: doc-inline            # sets the viewBox and the type ramp
nodes:
  - id: phone
    label: Odysseus's phone
    sub: Ogygia · capture
    tag: DEVICE
    role: input             # focal | default | store | external | input | optional | boundary
    at: [40, 120]           # free-layout types only; 4px grid, model-placed
    size: [148, 64]
    link: "[[raft-build]]"  # optional wiki-link: the node opens the document
groups:
  - id: brain
    label: THE BRAIN
    members: [inbox, filer, ledger]
edges:
  - { from: phone, to: inbox, label: CAPTURE, kind: primary }   # primary | link | default | async
focal: [filer]              # at most two; the renderer refuses a third
```

- Axis types (sequence, swimlane, timeline, Gantt) have no `at`. Order sets
  position: participants and messages, lanes and steps, dated events.
- The schema is a zod schema in the module, exported as JSON Schema into the
  integration contract.
- `brain diagram check --json` validates a spec and reports budget overruns
  (nodes, edges, focal count, label length) with the upstream budgets as the
  defaults.

## Geometry by construction

One pure builder, `buildDiagram(spec, { theme? }) → DiagramTree`, produces a
neutral element tree. The client entry maps it to React elements, and the
static entry serialises it to an SVG string, so the screen and the export
cannot drift. The builder computes everything upstream's six connector rules
govern:

1. Orthogonal routes with `r=8` elbows, and straight lines only when ends share
   an axis.
2. Arrow labels on opaque masks with a 6–10px gap, beside vertical segments,
   14 characters at most.
3. No shared or stacked strokes: parallel routes offset by 12px or more, and a
   bridge at a single crossing.
4. Attach points fanned at `L·k/(N+1)` along a shared edge, 12px apart (8px on
   small boxes).
5. No transit behind a non-endpoint box. A route that cannot avoid one is
   dashed, with its label at the visible end.
6. Masks drawn before any node they could overlap.

A spec the router cannot satisfy is a `check` error that names the edge, not a
drawing that breaks a rule. Property tests ported from upstream's geometry
cases prove each rule.

## The skin

Every paint is a `var(--bk-…)` reference. The static entry embeds a token
block generated from `packages/ui-kit/src/tokens.css`:

- the `light-dark()` pairs under `color-scheme: light dark`
- `[data-theme]` overrides
- a print block whose selectors outrank the theme selectors

A test regenerates the block and fails on any difference.

| Upstream role | brain-kit token |
| --- | --- |
| paper (page ground) | `--bk-diagram-bg` |
| paper-2 (container) | `--bk-diagram-cluster` |
| white card | `--bk-diagram-node` |
| ink (primary stroke and text) | `--bk-diagram-text` |
| muted (default arrow) | `--bk-diagram-line` |
| soft (sublabel) | `--bk-color-ink-mute`, or `--bk-diagram-text` on a focal tint |
| rule / rule-solid | `--bk-color-line` / `--bk-diagram-cluster-border` |
| accent (one or two focal elements) | `--bk-amber-ink` stroke and text, the solid `--bk-diagram-focal-tint`, `--bk-on-fill` on a solid fill |
| link (HTTP and external calls) | `--bk-blue-ink` |
| series 1–5 | `--bk-canvas-slot-1…` (`--bk-canvas-slot-1`, `packages/ui-kit/src/tokens.css:756`) |
| ink at opacity (tints, ramps) | solid `color-mix(in srgb, <ink> N%, <ground>)` steps; alpha ink is banned |

Type follows the kit:

- **Title:** DM Serif Text.
- **Node names:** Plus Jakarta Sans 600.
- **Sublabels, tags and arrow labels:** JetBrains Mono, with tags and labels in
  the 9.5px / 600 / 0.09em uppercase label style.
- **Floor:** nothing below 9px.

Label widths are budgeted per character, including tracking and wide glyphs.
The shared fit policy refuses sizes below 9px. The [adopted design](https://github.com/schlessera/brain-kit/blob/ce92ea1d4142481fadf6cef08bfef7eecf02543b/docs/assets/diagrams-2091/README.md)
uses amber focal ink, solid named focal grounds, 5px node and 8px group radii,
and diagram-text for focal sublabels. Optional authored 320px placement shares
semantic IDs; missing placement selects caption/summary and Open diagram,
without automatic reflow or a shrunken inline figure.

## Surfaces

| Surface | How it draws | Print |
| --- | --- | --- |
| Chat answer, file viewer (`.md`) | client entry, inline SVG under the app's `[data-theme]` | browser print reaches it; the print block forces white |
| A standalone spec file (`.diagram.yaml`) | client entry, via its extension claim | same |
| Share as PDF/PNG, `/api/render`, `brain render` | static entry, print or light theme | white |
| GitHub, a plain editor, a brain without the module | the fence as code | n/a, or `brain diagram build` writes a flattened `*.light.svg` / `*.dark.svg` pair for `<picture>` |

Two related fixes land in the same epic because generic SVG images still
reach the app through `![](x.svg)`:

- **An `.svg` file must open as an image.** Today it opens as source, because
  the byte sniff in `export function classifyKind`,
  `packages/ui-server/src/files/walker.ts:347` classifies UTF-8 SVG as text.
- **SVG images must print light.** Measured: a host
  `@media print { :root { color-scheme: light } }` makes an `<img>` SVG take its
  light palette.

## Order

1. **The seam types and the manifest key** come first. Everything else is
   written against them.
2. **The client registry, with Mermaid migrated onto it,** before any new
   pack. Mermaid is the regression suite for the seam: three call sites,
   share export, file preview. If the seam cannot carry Mermaid unchanged, it
   is wrong.
3. **The static path** (`brain render`, `/api/render`) follows the registry,
   with Mermaid's browser-only static step as its hard case.
4. **The module scaffold, the spec and the geometry builder** need nothing
   from the UI and can start at once, in parallel with steps 1–3.
5. **The design briefs gate the skin.** Nothing is painted until the fusion
   has been seen in light, dark and print.
6. **The renderer pack, then the type families, then the skill and the
   export commands.** The skill comes last, because it teaches the model the
   types that actually shipped.
7. **The hosting template's build** registers module packs once the client
   registry exists.

## Keeping up with upstream

The module ships the [upstream review procedure](../../packages/module-diagrams/UPSTREAM.md), including report generation, the four triage outcomes, re-authoring and pin movement.

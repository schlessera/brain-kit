# Diagrams module

The module provides `brain diagram check <file|-> --json` and upstream review
tooling. Check validates a versioned standalone YAML spec or one `diagram`
fence, with strict fields, reference checks, editorial budget warnings and
free-layout grid/overlap and connector routing checks. The [v1 contract](../../docs/integration-contract/diagrams.md)
lists the common type families and envelope. The pure `buildDiagram(spec, options)` export constructs a neutral free-layout
`DiagramTree` with rounded orthogonal paths, crossing hops and measured label
masks. Axis types derive their geometry from order and authored dates. The `ui` entry exports `diagramsContentPack` for trusted app builds;
`render` exports `diagramsStaticPack` and browser-free `toStatic`. The authoring
skill and node-link specialized grammars remain separate work.

Enable the module in a brain configuration:

```ts
modules: {
  "@schlessera/brain-module-diagrams": {},
}
```

Run `brain module lint diagrams` to validate the configured module.

[UPSTREAM.md](UPSTREAM.md) explains how to review the pinned upstream method.
`upstream.json` records the last reviewed state; the module's [LICENSE](LICENSE)
contains the attribution for adapted rules, budgets and type grammars.
Upstream examples and HTML are never vendored.

```sh
brain diagram check homecoming.diagram.yaml --json
cat homecoming.md | brain diagram check - --json
```

No network or rendering is required. Budget warnings preserve exit 0; errors
return exit 1. A newer spec version asks you to upgrade the module.

## Diagram skin

`DIAGRAM_TOKEN_CSS` embeds the kit's generated light/dark/print palette on
`.bk-diagram`. After token edits, run
`bun packages/module-diagrams/scripts/generate-skin.ts`; the pin test refuses
drift. Painters share `DIAGRAM_TYPE`, `fitDiagramText`, `diagramNodePaint`
and `diagramEdgePaint`, preserving the 9px floor and semantic stroke cues.
Optional `layouts.narrow` authors 320px placement without duplicating semantic
nodes or edges; `buildDiagramLayout` validates and builds that exact frame.
See the [spec and skin contract](../../docs/integration-contract/diagrams.md).

## Bundled renderer

A host registers `diagramsContentPack` from
`@schlessera/brain-module-diagrams/ui` through the app's
`registerContentRendererPack`; the configured manifest declares `diagram` and
`.diagram.yaml`. The UI peer packages and React are optional for CLI-only brains.
The trusted static build registers `diagramsStaticPack` from the `render` entry.

Both entries paint the same neutral geometry with the generated tokens. Linked
nodes resolve and open documents through the app's wiki-link navigation. Keyboard
focus outlines a node and strengthens its incident edges. A figure can share
SVG, PNG or PDF through the existing share path, always using the print palette.

Inline figures retain native coordinates so displayed text never shrinks below
9px. A constrained container uses the authored 320px layout when it fits;
otherwise it shows the caption, semantic summary and a 44px Open diagram button.
The dedicated viewer starts at readable 100% with explicit pan/zoom controls.
Browser print uses a white, non-interactive drawing without the screen frame.

## Ordered axis diagrams

Sequence, swimlane, timeline and Gantt specs add a strict optional `axis` block
with type-specific messages, lane ownership or dates. Existing v1 nodes/edges
remain accepted. [Sequence](skills/diagram/references/type-sequence.md),
[swimlane](skills/diagram/references/type-swimlane.md),
[timeline](skills/diagram/references/type-timeline.md) and
[Gantt](skills/diagram/references/type-gantt.md) references include shipped
Odysseus examples. All four share the same light/dark/white-print painter.

Sequences preserve normal text sizes and reflow at 320px only when participant
names, optional authored tags, message labels, notes and self-messages fit. A
64px participant pitch alone is insufficient. Unsafe inline layouts use the
semantic summary and Open diagram viewer. Swimlane handoffs use the shared
connector router; timeline distances and Gantt durations use honest date
intervals. Per-type editorial overruns warn and suggest overview/detail.

## Positional diagrams

Quadrant, layer-stack, pyramid, funnel, loop, flywheel and Venn accept an
optional strict `positional` block. Common semantic nodes remain authoritative;
the selected family supplies axes, bands, proportional trapezoids, circular
rings or overlapping circles. Existing v1 forms remain accepted. Each
[type reference](skills/diagram/references/quadrant.md) links a shipped Odysseus
example; the [contract](../../docs/integration-contract/diagrams.md#positional-families-additive-2097)
lists all fields and geometry rules. Editorial excess warns; ambiguous
references, misleading geometry and text below 9px refuse. Missing authored
narrow placement uses the semantic summary and readable viewer.

Export a chosen palette without live CSS variables, or build light/dark pairs
from identified Markdown fences:

```sh
brain diagram export release.diagram.yaml --theme print --format svg --json
brain diagram export release.diagram.yaml --format png --json
brain diagram build dispatch.md --json
```

PNG/PDF use the optional `@schlessera/brain-render-puppeteer` package and Chrome;
SVG is browser-free. Artifacts embed the licensed locked kit fonts as data,
including standalone SVG pairs. Build writes `id.light.svg` / `id.dark.svg` beside the source
and prints a `<picture>` snippet. It preserves Markdown and refuses another
source's or manually authored SVG. Add `id: release` at the spec's top level;
unnamed fences warn and skip. `brain audit` detects invalid fences, stale built
pairs and fences whose module is absent/dormant. Unrelated prose edits preserve
pair freshness. See the [export/build contract](../../docs/integration-contract/diagrams.md#export-derived-pairs-and-hygiene-additive-2099)
for exact envelopes, naming, ownership and partial-write behavior.

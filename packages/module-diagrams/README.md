# Diagrams module

The module provides `brain diagram check <file|-> --json` and upstream review
tooling. Check validates a versioned standalone YAML spec or one `diagram`
fence, with strict fields, reference checks, editorial budget warnings and
free-layout grid/overlap and connector routing checks. The [v1 contract](../../docs/integration-contract/diagrams.md)
lists the common type families and envelope. The pure `buildDiagram(spec, options)` export constructs a neutral free-layout
`DiagramTree` with rounded orthogonal paths, crossing hops and measured label
masks. The `ui` entry exports `diagramsContentPack` for trusted app builds;
`render` exports `diagramsStaticPack` and browser-free `toStatic`. The authoring
skill and specialized family grammars remain separate work.

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

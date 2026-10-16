# Diagrams module

The module provides `brain diagram check <file|-> --json` and upstream review
tooling. Check validates a versioned standalone YAML spec or one `diagram`
fence, with strict fields, reference checks, editorial budget warnings and
free-layout grid/overlap and connector routing checks. The [v1 contract](../../docs/integration-contract/diagrams.md)
lists the common type families and envelope. The pure `buildDiagram(spec, options)` export constructs a neutral free-layout
`DiagramTree` with rounded orthogonal paths, crossing hops and measured label
masks. Renderers and an authoring skill remain separate; `ui` and `render` export nothing.

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

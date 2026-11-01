# @schlessera/brain-module-diagrams

## 0.44.0

### Minor Changes

- d99f399: Add generated diagram paint tokens, accessible type and contrast checks, and optional authored narrow layouts; align shared dark and print cluster paint with the approved design.
- c1e1de0: Add sequence, swimlane, timeline and Gantt grammars with ordered geometry, checked budgets and readable themed rendering.
- af0547c: Enclose computed groups and headings in fit canvases without moving authored nodes. Previously accepted clipped fixed/narrow inputs now fail validation. Report scene_bounds for clipped fixed groups and layout findings for clipped narrow groups, and honor nonzero viewBox origins in client, static and flattened exports, annotations and legends.
- 05d6c73: Ship the diagram authoring skill and generated module workflow instructions, with worked examples and type-reference routing. Distinguish structured diagram figures from pictorial image generation and correct the shipped node-link check commands.
- 61c73e2: Add diagram SVG/PNG/PDF export, owned light/dark Markdown build pairs and fresh-source hygiene. Expose concrete GFM fence extraction and offline HTML artifact rendering helpers through the module API.
- a769d0f: Add accessible inline and static diagram renderer packs with authored narrow layouts, readable viewer fallback and print-themed sharing.
- d585b09: Add the diagrams module scaffold with help-only CLI and pinned upstream review tooling.
- dd22d23: Add the pure free-layout `buildDiagram` and neutral `DiagramTree` API with rounded orthogonal routing, fanned ports, single-owner crossing hops and measured opaque label masks. Diagram checks now name edges whose geometry cannot satisfy the routing rules.
- 0d2a40c: Add the versioned diagram YAML schema and `brain diagram check` for standalone files and Markdown fences, with strict fields, reference integrity, editorial budget warnings, and free-layout grid and overlap checks.
- 52e672b: Add quadrant, layer, pyramid, funnel, loop, flywheel and Venn grammars with shared typed geometry, token paint, budgets and packaged Odysseus examples.
- 99c67ce: Preserve common callout text and target association in shared client/static,
  print and summary output. Add preferred-side hints and readable sans notes.
  Repeated-target notes share a target key and grouped band, with every full
  note and its original source index. Wide frames use two columns; narrow
  frames keep one. Unmarked and semantic-only targets retain explicit notes
  without invented geometry.

  Breaking validation change: fixed named canvases with neither readable
  collision-free inline placement nor notes-band room now return `callout_room`.
  Reserve annotation space or choose `size: fit`. When repeated notes still fit
  inline but their band does not, preserve all of them inline; this exception
  does not expand the validation break. Previously accepted `fit` sources remain
  valid.

- 9b7e77a: Add typed architecture containment, flowchart, state, tree, ER and dependency
  semantics to v1 diagrams, with shared client/static shapes, readable cardinalities,
  rank/cycle and per-type checks, and Odysseus examples with browser baselines.

### Patch Changes

- 789f407: Allow valid labels beside rounded connector elbows by bounding the actual quarter arcs while preserving the 8px path clearance.
- Updated dependencies [603a754]
- Updated dependencies [c69d04e]
- Updated dependencies [04a6595]
- Updated dependencies [d2bb3b3]
- Updated dependencies [61c73e2]
- Updated dependencies [800d965]
- Updated dependencies [bde209b]
- Updated dependencies [ff70ec1]
- Updated dependencies [dc5d3c7]
- Updated dependencies [69151ca]
- Updated dependencies [4931275]
- Updated dependencies [caae12d]
- Updated dependencies [918b34a]
- Updated dependencies [caae12d]
- Updated dependencies [c5d2755]
- Updated dependencies [8476426]
- Updated dependencies [caae12d]
- Updated dependencies [79bab30]
- Updated dependencies [d5692af]
- Updated dependencies [1faf79c]
  - @schlessera/brain@0.44.0

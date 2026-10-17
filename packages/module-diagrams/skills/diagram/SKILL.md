---
name: diagram
description: Create structured, themed diagram figures from brain-kit specs when relationships, processes, states, hierarchies, time, positions or set overlap are the explanation. Prefer this for a figure to keep or share; use Mermaid for a quick sketch and image-gen for pictorial illustrations, labelled cutaways, posters or image edits.
compatibility: Requires the enabled @schlessera/brain-module-diagrams module and the brain CLI. Inline app rendering also requires its renderer pack in the host build.
---

# Diagram authoring

The skill chooses and authors; `brain diagram check` validates. Geometry, routing,
fonts, theme paints and print belong to the module. The source is a versioned
YAML spec in a `diagram` fence or a standalone `.diagram.yaml` file. Do not
write raw SVG/HTML, supply CSS or palette overrides, or reproduce the router.

## Decide whether to draw

Draw when the reader needs the structure, order, position or overlap to answer
the question. A list of attributes belongs in a table; a single relationship
may need only a sentence. A topology change can merit a figure; attribute-only
before/after usually needs a table. Use Mermaid for a quick conversational
sketch. Use this skill for a deliberate figure with the kit's light, dark and
white-print treatments. A pictorial cutaway or illustration belongs to image-gen;
its visual appearance is different from a structured relationship spec.

## Choose meaning, then type

First name the question the figure answers. When behavior or risk carries the
meaning, identify that pattern before choosing layout: contention needs distinct
sources and a capacity statement; policy divergence needs explicit outcomes;
a lifecycle needs waits, retries and terminal states; a boundary needs named
actors and permitted/blocked routes. Use only fields supported by the chosen
reference. A semantic pattern never invents a new namespace or primitive.
If the necessary detail cannot fit, use a companion table or separate figure.

Read the selected type reference before authoring. References contain exact
fields, constraints and shipped Odysseus examples; load only the ones needed.

| What the reader needs | Type and reference |
| --- | --- |
| Components, distinct sources, connections and trust/containment boundaries | [Architecture](references/type-architecture.md) |
| Decisions, branching and explicit outcomes | [Flowchart](references/type-flowchart.md) |
| One subject's states, waits, retries and terminal outcomes | [State machine](references/type-state-machine.md) |
| Time-ordered messages between actors | [Sequence](references/type-sequence.md) |
| Ownership lanes and handoffs | [Swimlane](references/type-swimlane.md) |
| Single-parent decomposition or hierarchy | [Tree](references/type-tree.md) |
| Entities, fields and relationships | [ER](references/type-er.md) |
| Shared dependencies, fan-in or a labelled cycle | [Dependency](references/type-dependency.md) |
| Events at honest dates or intervals | [Timeline](references/type-timeline.md) |
| Task durations and phases on a calendar | [Gantt](references/type-gantt.md) |
| Two-axis conceptual positioning | [Quadrant](references/quadrant.md) |
| Ordered abstraction/control layers | [Layer stack](references/layer-stack.md) |
| Ranked layers or narrowing conversion | [Pyramid](references/pyramid.md), [funnel](references/funnel.md) |
| A returning cycle with one accumulated-state hub | [Loop](references/loop.md), [flywheel](references/flywheel.md) |
| Set membership and intersections | [Venn](references/venn.md) |

A state machine describes one subject's changes; sequence describes messages
between subjects. A tree needs one parent per child; shared children or cycles
need dependency. For numeric trends, distributions or part-to-whole data,
prefer an appropriate data chart or table rather than forcing it into these
types. This skill does not add the upstream catalogue's unimplemented types.

## Plan and apply the taste gate

State a short plan: the chosen type, size, focal idea and any assumptions or
detail deferred to a companion view. Then proceed within the user's request;
there is no mandatory approval pause for an ordinary figure.

- Every node is a distinct idea; every edge carries a relationship. Remove
  decoration and redundant connections, preserving all required facts and
  identities. Do not collapse distinct sources merely to meet a target count.
- Decide what is focal: usually one, never more than two overall. Follow a
  type's focal rule, such as one Venn intersection. Color reinforces
  labels, roles and line styles; it never supplies the only meaning.
- Prefer short noun names and concise relationship labels. The default
  editorial budgets are 9 nodes, 12 edges, 2 callouts and 14 characters per
  arrow label; load the type-specific budgets. An overrun is guidance to split
  overview/detail, not permission to discard content or shrink text.
- Keep uncertainty explicit. Do not invent scores, positions, dates, capacities,
  weights or zero values. Quantitative geometry must represent the supplied
  values; mark qualitative comparisons clearly. Author the selected typed
  fields rather than relying on legacy interpretations.
- Keep the kit's fonts, solid token paints and 9px displayed floor. Shorten or
  split unreadable content; do not override the renderer to fit it.

## Author, check, then present

Use `schema_version: 1`, a shipped `type`, a concise `title`, a useful `desc`,
`size`, semantic `nodes` and `edges`. Add only the chosen reference's fields.
For the six node-link types, author every node's `at` and `size` on the 4px grid;
the builder routes connectors without moving nodes. Ordered-axis and positional
families use their typed data instead of authored `at`/`size`.

Save the candidate as a standalone `.diagram.yaml` file and validate it:

```sh
brain diagram check homecoming.diagram.yaml --json
```

The same command accepts a Markdown file containing exactly one diagram fence;
`brain diagram check - --json` reads source from stdin. Read `valid`, `errors`
and `warnings`. Correct errors at their named paths and reassess budget or
interpretation warnings. A green check validates the spec; it does not prove
the explanation is complete. Recheck the meaning and layout before presenting
the validated source in a `diagram` fence or saving the requested document.

The common `callouts` field is accepted and budgeted, but its annotations are
not yet painted (tracked in [the callout issue](https://github.com/schlessera/brain-kit/issues/2242)). Do not put essential explanation only in
callouts. Preserve it in `desc` and adjacent prose until callout rendering ships;
no annotation treatment or placement is invented by this skill.

A free-layout figure may add complete authored `layouts.narrow` placement at
320px, sharing the original node IDs and semantics. Do not infer automatic
placement. Sequence has its own safe narrow layout; other non-fitting figures
use a caption/summary and Open diagram viewer. Never shrink text to force an
inline fit. A host without the bundled pack shows source with a not-bundled
note; do not claim a capture or rendered preview that you have not seen.

## Worked examples

A compact component relationship, dated in the Odysseus example world. Two
nodes are sufficient for the question; do not add boxes to fill the canvas.

```diagram
schema_version: 1
type: architecture
title: Voyage record
desc: Odysseus records the voyage on 2026-07-12.
size: fit
nodes:
  - id: odysseus
    label: Odysseus
    role: focal
    at: [32, 32]
    size: [160, 64]
  - id: ledger
    label: Voyage ledger
    role: store
    at: [320, 32]
    size: [160, 64]
edges:
  - from: odysseus
    to: ledger
    label: RECORD
    kind: async
```

For an exchange, the message order is the story. The full
[sequence example](references/examples/sequence.diagram.yaml) adds the other
participants, return, async, self-message and note using the same grammar.

```diagram
schema_version: 1
type: sequence
title: Release order
desc: Zeus sends Hermes the release order on 2026-07-12.
size: doc-inline
nodes:
  - id: zeus
    label: Zeus
  - id: hermes
    label: Hermes
edges: []
axis:
  kind: sequence
  messages:
    - id: release
      from: zeus
      to: hermes
      label: RELEASE ORDER
      focal: true
```

Adapted selection and deletion-first method from the module's pinned MIT
upstream reference. The kit's adopted design and implemented grammars govern;
there is no brand-profile interview or external script/export workflow here.

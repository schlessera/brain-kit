# Diagram spec v1 and check (additive, 0.44.0, #2089)

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
are `groups`, `focal`, `callouts` and `link`. Text fields other than title have
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

This is the common grammar for those families. It does not claim a renderer or
specialized participants/messages, lanes/steps, dated-event or type-specific
content fields. Those are separate additive family work. Other type names are
refused. Geometry construction and edge routing are separate from validation.

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
`focal_count`, `tree_cycle`, `grid`, and `overlap`. Warnings use `budget`.
A numeric input `schema_version` newer than 1 returns `upgrade_required` at
`$.schema_version` with an instruction to upgrade the diagrams module.

Exit 0 means no errors (warnings may exist); exit 1 means invalid input, usage
or an unreadable source. `--json` writes only the result on stdout. The core's
normal machine-output selection applies; `--human` selects readable findings.

# Sequence

Use for ordered exchanges between participants. `nodes` lists participants in column order; names are required, `tag` is optional authored data. `axis.kind: sequence` adds ordered `messages`: unique `id`, `from`, `to`, `label`, optional `kind` (`message`, `return`, `async`), `focal`, and `note`. A self-message has the same sender and recipient. Original v1 edges remain supported as ordered messages when `axis` is omitted.

Optional `fragments` contain `kind` (`alt`, `opt`, `loop`), zero-based inclusive message `from`/`to`, and a `guard`. An `alt` requires `elseAt` to begin its second region, with optional `elseGuard`. Only two regions are supported; no other UML operators, create/destroy or duration bars.

Budget: five participants, twelve messages, two notes, at most two focal messages. Default one fragment; two only for single-region opt/loop; nesting budget one. Excess editorial density warns; invalid references/ranges and a third focal message refuse.

Solid lifelines, outlined activations, dotted async (`1.5 3.5`, round caps), dashed returns (`6 4`), open chevrons except the focal filled triangle. Notes use sans text, never italic serif. At 320px derived geometry reflows only if normal type, 64px participant pitch and every name/tag/message/self-message/note fit. Otherwise the app shows summary and Open diagram; never shrink or scroll inline.

Canonical shipped example: [`examples/sequence.diagram.yaml`](examples/sequence.diagram.yaml) (Odysseus world, pinned 2026-07-12 context). Adapted from diagram-design at the module’s pinned upstream revision; brain-kit’s approved skin and sequence ruling #2092 take precedence.

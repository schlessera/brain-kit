---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-pi": minor
---

Tool component contracts: one declaration per tool, read by both halves.

A tool that renders as a component was previously described in four places at
once — a name constant, a description constant, an input schema, a payload
interface the handler happened to return, and a hand-written paragraph in the
system prompt. Nothing tied them together, so a tool could be schema'd and
never described to the model, and a renderer could be typed for a payload the
handler had stopped sending.

`@schlessera/brain-ui-sdk/tool-contracts` is now the single declaration:
`{ name, description, input, brief }`, plus `payload` for a tool whose result
is meant to be drawn rather than read. It is React-free and free of node
built-ins, so the server builds its tool definitions and prompt brief from the
same object the browser parses payloads with. The four bridge tools —
`ask_user`, `get_current_location`, `request_image_mask`, `query_activity` —
are declared there; the handlers stay in `/server` and both barrels re-export
the contracts, so backend import sites are unchanged.

What this closes:

- The prompt's tool paragraph is GENERATED from the contract list. Adding a
  contract without deciding how a backend declares its tool is a `tsc` error.
- Payload schemas are bound to their interfaces in both directions by a
  compile-time equality test, so a schema that drifts from what the handler
  returns fails the typecheck rather than a renderer at runtime.
- `pi`'s `request_image_mask` now serialises its payload into `output` like
  every other payload tool, instead of reporting a sentence. That is a
  deliberate change to what the model sees, and it carries the `note` field pi
  used to drop.
- Both backends convert input schemas through one helper, so the same tool
  advertises the same JSON Schema on either adapter.

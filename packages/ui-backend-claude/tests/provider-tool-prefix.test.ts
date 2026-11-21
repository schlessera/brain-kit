import { expect, test } from "bun:test";
import { history, providerTools, type Exchange } from "../../../tests/helpers/provider-history.js";
const read = { name: "Read", input_schema: { type: "object" } };
const graph = { name: "brain_graph", defer_loading: true, input_schema: { type: "object" } };
function pair(before: unknown[], after: unknown[], call = "ToolSearch", refs = ["brain_graph"]): [Exchange, Exchange] {
  const input = [{ role: "user", content: "Odysseus checks Ithaca." }];
  const answer = { role: "assistant", content: [{ type: "tool_use", id: "toolu_ithaca", name: call, input: {} }] };
  const previous = { turn: 0, path: "/v1/messages", main: true, raw: JSON.stringify({ tools: before, messages: input }), answer };
  const next = { ...previous, raw: JSON.stringify({ tools: after, messages: [...input, answer, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ithaca", content: refs.map(name => ({ type: "tool_reference", tool_name: name })) }] }] }) };
  return [previous, next];
}
test("only referenced discovery can insert definitions while preserving earlier definitions and relative order", () => {
  providerTools(...pair([read], [read]), "unchanged");
  providerTools(...pair([read], [read, graph]), "append");
  providerTools(...pair([read], [graph, read]), "sorted insertion");
  expect(() => providerTools(...pair([read, graph], [graph, read]), "reorder")).toThrow();
  expect(() => providerTools(...pair([read, graph], [read]), "removal")).toThrow();
  expect(() => providerTools(...pair([read, graph], [read, { ...graph, input_schema: {} }]), "edited schema")).toThrow();
  expect(() => providerTools(...pair([read], [read, { name: "Write" }]), "non-deferred")).toThrow();
  expect(() => providerTools(...pair([read, graph], [read, graph, graph]), "duplicate")).toThrow();
});
test("an ordinary Read or unreferenced deferred name cannot authorize tool discovery", () => {
  expect(() => providerTools(...pair([read], [read, graph], "Read"), "ordinary Read")).toThrow();
  expect(() => providerTools(...pair([read], [read, graph], "ToolSearch", ["NeverDiscovered"]), "wrong reference")).toThrow();
  expect(() => providerTools(...pair([read], [read, graph], "ToolSearch", []), "empty discovery")).toThrow();
});

test("the strict history guard rejects #4324 rewrites on the same turn and resume, with or without a successor", () => {
  for (const resumed of [false, true]) for (const successor of [false, true]) {
    const [previous, next] = pair([read], [read]);
    const before = JSON.parse(previous.raw), after = JSON.parse(next.raw);
    const instruction = { role: "system", content: [{ type: "text", text: "Odysseus checks Ithaca." }] };
    before.messages.unshift(instruction);
    after.messages.unshift({ ...instruction, content: "Odysseus checks Ithaca." });
    if (!successor) after.messages.pop();
    if (resumed) next.turn = 1;
    previous.raw = JSON.stringify(before); next.raw = JSON.stringify(after);
    expect(() => history(previous, next)).toThrow("messages turn 0 ->");
  }
  const [previous, next] = pair([read], [read]);
  const after = JSON.parse(next.raw); after.messages.pop(); next.raw = JSON.stringify(after);
  expect(() => history(previous, next)).toThrow();
});


test("cache breakpoint movement cannot hide a schema property or tool input edit", () => {
  const tool = { ...read, cache_control: { type: "ephemeral" }, input_schema: { type: "object", properties: {} } };
  providerTools(...pair([tool], [{ ...tool, cache_control: undefined }], "Read"), "top-level breakpoint");
  const edited = { ...tool, input_schema: { ...tool.input_schema, properties: { cache_control: { type: "string" } } } };
  expect(() => providerTools(...pair([tool], [edited], "Read"), "schema property"), "CACHE_CONTROL_SCHEMA_EDIT_IS_REAL_HISTORY").toThrow("first differing byte");
  const [a, b] = pair([read], [read]);
  const request = JSON.parse(b.raw);
  request.messages[1].content[0].input.cache_control = "changed tool input";
  b.raw = JSON.stringify(request);
  expect(() => history(a, b), "CACHE_CONTROL_TOOL_INPUT_IS_REAL_HISTORY").toThrow("first differing byte");
});

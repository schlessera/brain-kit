import { expect, test } from "bun:test";
import { history, providerTools, qualifyHistory, type Exchange } from "../../../tests/helpers/provider-history.js";
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

test("qualification preserves the strict #4324 failure and rejects other earlier-message changes", () => {
  const [previous, next] = pair([read], [read]);
  const before = JSON.parse(previous.raw), after = JSON.parse(next.raw);
  const instruction = { role: "system", content: [{ type: "text", text: "Odysseus checks Ithaca." }] };
  before.messages.unshift(instruction);
  after.messages.unshift({ ...instruction, content: "Odysseus checks Ithaca." });
  previous.raw = JSON.stringify(before); next.raw = JSON.stringify(after);
  expect(() => history(previous, next)).toThrow("messages turn 0 -> 0");
  expect(qualifyHistory(previous, next)).toMatchObject({ issue: 4324, indices: [0] });
  after.messages[0].content = "Penelope checks Ithaca.";
  next.raw = JSON.stringify(after);
  expect(() => qualifyHistory(previous, next)).toThrow();
  after.messages[0] = instruction;
  next.raw = JSON.stringify(after);
  expect(qualifyHistory(previous, next)).toBeNull();
});

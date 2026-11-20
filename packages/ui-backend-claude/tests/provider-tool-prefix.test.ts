import { expect, test } from "bun:test";
import { appendOnlyTools } from "../../../tests/helpers/provider-history.js";
const read = { name: "Read", input_schema: { type: "object" } };
const graph = { name: "brain_graph", defer_loading: true, input_schema: { type: "object" } };
test("discovery guard allows only unchanged tools or newly appended deferred definitions", () => {
  appendOnlyTools([read], [read], "unchanged");
  appendOnlyTools([read], [read, graph], "first discovery");
  expect(() => appendOnlyTools([read], [graph, read], "sorted insertion")).toThrow("sorted insertion");
  expect(() => appendOnlyTools([read, graph], [read], "removal")).toThrow();
  expect(() => appendOnlyTools([read, graph], [read, { ...graph, input_schema: {} }], "edited schema")).toThrow("edited schema");
  expect(() => appendOnlyTools([read], [read, { name: "Write" }], "non-discovery")).toThrow();
  expect(() => appendOnlyTools([read, graph], [read, graph, graph], "rediscovery")).toThrow();
});

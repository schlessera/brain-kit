import { describe, test, expect } from "bun:test";
import {
  shrinkForReplication,
} from "../src/ws/shrink";

// Pin the default frame budget independently of the implementation.
const FRAME_BUDGET_BYTES = 512_000;

describe("shrinkForReplication", () => {
  test("returns small payloads unchanged (same reference)", () => {
    const msg = { type: "text_delta", text: "hello world" };
    expect(shrinkForReplication(msg)).toBe(msg);
  });

  test("leaves a payload just under the cap untouched", () => {
    const msg = { type: "tool_result", output: "x".repeat(FRAME_BUDGET_BYTES - 200) };
    expect(shrinkForReplication(msg)).toBe(msg);
  });

  test("head-truncates an oversized string and stays under the cap", () => {
    const huge = "a".repeat(5_000_000);
    const msg = {
      type: "tool_result",
      toolUseId: "toolu_keepme",
      output: huge,
      isError: false,
    };
    const shrunk = shrinkForReplication(msg);
    expect(shrunk).not.toBe(msg);
    expect(JSON.stringify(shrunk).length).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
    // Discriminator + small ids survive verbatim.
    expect(shrunk.type).toBe("tool_result");
    expect(shrunk.toolUseId).toBe("toolu_keepme");
    expect(shrunk.isError).toBe(false);
    // The output is truncated and carries an elision marker.
    expect(shrunk.output.length).toBeLessThan(huge.length);
    expect(shrunk.output).toContain("chars elided");
    // Truncation is head-preserving.
    expect(shrunk.output).toStartWith("aaaa");
  });

  test("head-clips an oversized array of many small blocks", () => {
    const content = Array.from({ length: 50_000 }, (_, i) => ({
      type: "text",
      text: `block-${i}`,
    }));
    const msg = { type: "tool_result", content };
    const shrunk = shrinkForReplication(msg);
    expect(JSON.stringify(shrunk).length).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
    expect(shrunk.content.length).toBeLessThan(content.length);
    // Typed arrays must contain only their original element type.
    expect(shrunk.content.filter((block) => typeof block !== "object")).toEqual([]);
    // Head blocks are preserved in order.
    expect(shrunk.content[0]).toEqual({ type: "text", text: "block-0" });
  });

  test("converges on a pathological mix of huge strings and huge arrays", () => {
    const msg = {
      type: "session_history",
      messages: Array.from({ length: 5_000 }, (_, i) => ({
        role: "assistant",
        content: "z".repeat(2_000),
        toolCalls: [{ id: `t${i}`, name: "Read", input: {}, output: "y".repeat(5_000) }],
      })),
    };
    const shrunk = shrinkForReplication(msg);
    expect(JSON.stringify(shrunk).length).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
    expect(shrunk.type).toBe("session_history");
  });
});

test("shrinking an activity snapshot preserves its scope keys but does not acknowledge omitted lifecycle records", () => {
  const life = { lifecycleId: "lifecycle:ithaca", turnId: "ithaca", backendMissingEvidence: Array.from({ length: 32 }, (_, i) => `mcp_connect:ithaca-${i}-${"x".repeat(190)}`) };
  const lifecycles = Array.from({ length: 100 }, (_, i) => ({ ...life, lifecycleId: `lifecycle:ithaca-${i}`, turnId: `ithaca-${i}` }));
  const frame = { type: "activity_snapshot", view: "index", spans: [], events: [], lifecycles,
    highWaterSeq: Object.fromEntries(lifecycles.map(record => [record.lifecycleId, 2])) };
  const shrunk = shrinkForReplication(frame);
  expect(shrunk.lifecycles.length).toBeLessThan(100);
  const received = new Set(shrunk.lifecycles.map(record => record.lifecycleId));
  expect(Object.keys(shrunk.highWaterSeq), "SHRINK_RETAINS_AUTHORITATIVE_SCOPE_KEYS").toHaveLength(100);
  for (const record of lifecycles) expect(shrunk.highWaterSeq[record.lifecycleId], "SHRINK_NEVER_ACKNOWLEDGES_DROPPED_LIFECYCLE")
    .toBe(received.has(record.lifecycleId) ? 2 : 0);
  expect(Object.values(frame.highWaterSeq)).toEqual(Array(100).fill(2));
});

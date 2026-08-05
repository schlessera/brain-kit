import { describe, test, expect } from "bun:test";
import {
  shrinkForReplication,
  MAX_WS_MESSAGE_BYTES,
} from "../src/ws/shrink";

describe("shrinkForReplication", () => {
  test("returns small payloads unchanged (same reference)", () => {
    const msg = { type: "text_delta", text: "hello world" };
    expect(shrinkForReplication(msg)).toBe(msg);
  });

  test("leaves a payload just under the cap untouched", () => {
    const msg = { type: "tool_result", output: "x".repeat(MAX_WS_MESSAGE_BYTES - 200) };
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
    expect(JSON.stringify(shrunk).length).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
    // Discriminator + small ids survive verbatim.
    expect(shrunk.type).toBe("tool_result");
    expect(shrunk.toolUseId).toBe("toolu_keepme");
    expect(shrunk.isError).toBe(false);
    // The output is truncated and carries an elision marker.
    expect(shrunk.output.length).toBeLessThan(huge.length);
    expect(shrunk.output).toContain("chars elided");
    // Truncation is head-preserving.
    expect(shrunk.output.startsWith("aaaa")).toBe(true);
  });

  test("head-clips an oversized array of many small blocks", () => {
    const content = Array.from({ length: 50_000 }, (_, i) => ({
      type: "text",
      text: `block-${i}`,
    }));
    const msg = { type: "tool_result", content };
    const shrunk = shrinkForReplication(msg);
    expect(JSON.stringify(shrunk).length).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
    expect(shrunk.content.length).toBeLessThan(content.length);
    // The clip marker is the last element.
    expect(JSON.stringify(shrunk.content[shrunk.content.length - 1])).toContain(
      "items elided"
    );
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
    expect(JSON.stringify(shrunk).length).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
    expect(shrunk.type).toBe("session_history");
  });
});

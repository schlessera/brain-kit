import { describe, expect, test } from "bun:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { mapPiEvent, createUsageAccumulator } from "../src/backend";

describe("mapPiEvent", () => {
  test("text_delta → ServerTextDelta", () => {
    const ev = {
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} },
    } as unknown as AgentSessionEvent;
    expect(mapPiEvent(ev)).toEqual([{ type: "text_delta", text: "Hello" }]);
  });

  test("thinking_delta → ServerThinkingDelta", () => {
    const ev = {
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: {} },
    } as unknown as AgentSessionEvent;
    expect(mapPiEvent(ev)).toEqual([{ type: "thinking_delta", text: "hmm" }]);
  });

  test("non-delta assistant events (e.g. text_start) map to nothing", () => {
    const ev = {
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
    } as unknown as AgentSessionEvent;
    expect(mapPiEvent(ev)).toEqual([]);
  });

  test("tool_execution_start → start + complete (full input) + status", () => {
    const ev = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "brain_search",
      args: { query: "notes" },
    } as unknown as AgentSessionEvent;
    expect(mapPiEvent(ev)).toEqual([
      { type: "tool_use_start", toolUseId: "call-1", toolName: "brain_search" },
      {
        type: "tool_use_complete",
        toolUseId: "call-1",
        toolName: "brain_search",
        input: { query: "notes" },
      },
      { type: "status", status: "tool_executing" },
    ]);
  });

  test("tool_execution_end → ServerToolResult with extracted text", () => {
    const ev = {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "brain_search",
      result: { content: [{ type: "text", text: "3 results" }], details: null },
      isError: false,
    } as unknown as AgentSessionEvent;
    expect(mapPiEvent(ev)).toEqual([
      { type: "tool_result", toolUseId: "call-1", output: "3 results", isError: false },
    ]);
  });

  test("error tool result preserves isError", () => {
    const ev = {
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "write_file",
      result: { content: [{ type: "text", text: "user said no" }], details: null },
      isError: true,
    } as unknown as AgentSessionEvent;
    expect(mapPiEvent(ev)).toEqual([
      { type: "tool_result", toolUseId: "call-2", output: "user said no", isError: true },
    ]);
  });

  test("unmapped lifecycle events (turn_start) produce no frames", () => {
    expect(mapPiEvent({ type: "turn_start" } as unknown as AgentSessionEvent)).toEqual([]);
  });
});

describe("createUsageAccumulator", () => {
  const msgEnd = (usage: unknown, model = "anthropic/claude-sonnet-5") =>
    ({ type: "message_end", message: { role: "assistant", model, usage } }) as any;

  test("sums assistant message_end usage into a wire block", () => {
    const acc = createUsageAccumulator();
    acc.observe(msgEnd({ input: 100, output: 20, cacheRead: 500, cacheWrite: 50, cost: { total: 0.01 } }));
    acc.observe(msgEnd({ input: 40, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } }));
    const wire = acc.toWire()!;
    expect(wire.inputTokens).toBe(140);
    expect(wire.outputTokens).toBe(30);
    expect(wire.cacheReadTokens).toBe(500);
    expect(wire.cacheCreationTokens).toBe(50);
    expect(wire.perModel!["anthropic/claude-sonnet-5"]!.costUsd).toBeCloseTo(0.012);
  });

  test("nothing observed → undefined (cost stays unknown, never zero)", () => {
    const acc = createUsageAccumulator();
    acc.observe({ type: "tool_execution_start" } as any);
    expect(acc.toWire()).toBeUndefined();
  });

  test("turn_end does not double-count the message message_end counted", () => {
    const acc = createUsageAccumulator();
    const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
    acc.observe(msgEnd(usage));
    acc.observe({
      type: "turn_end",
      message: { role: "assistant", model: "anthropic/claude-sonnet-5", usage },
    } as any);
    expect(acc.toWire()!.inputTokens).toBe(100);
  });

  test("non-assistant and usage-less messages are ignored", () => {
    const acc = createUsageAccumulator();
    acc.observe({ type: "message_end", message: { role: "user" } } as any);
    acc.observe({ type: "message_end", message: { role: "assistant" } } as any);
    expect(acc.toWire()).toBeUndefined();
  });
});

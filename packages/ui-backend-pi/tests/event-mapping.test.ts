import { describe, expect, test } from "bun:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { mapPiEvent } from "../src/backend";

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

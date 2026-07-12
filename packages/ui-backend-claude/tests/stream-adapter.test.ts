import { expect, test, describe } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { StreamAdapter } from "../src/stream-adapter";

// Minimal SDK message shapes derived from the adapter's own switch arms. The
// adapter reads only a handful of fields per arm, so fixtures carry just those.
const asMsg = (m: unknown) => m as SDKMessage;

describe("StreamAdapter", () => {
  test("tool_use content_block_start → tool_use_start and tracks the id", () => {
    const adapter = new StreamAdapter();
    const out = adapter.adapt(
      asMsg({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "tool-1", name: "Read" },
        },
      })
    );
    expect(out).toEqual([
      { type: "tool_use_start", toolUseId: "tool-1", toolName: "Read" },
    ]);
  });

  test("text/thinking/input_json deltas map to their frames", () => {
    const adapter = new StreamAdapter();
    // Prime the current tool id so input_json_delta can reference it.
    adapter.adapt(
      asMsg({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "tool-9", name: "Bash" },
        },
      })
    );

    expect(
      adapter.adapt(
        asMsg({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "hello" },
          },
        })
      )
    ).toEqual([{ type: "text_delta", text: "hello" }]);

    expect(
      adapter.adapt(
        asMsg({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "hmm" },
          },
        })
      )
    ).toEqual([{ type: "thinking_delta", text: "hmm" }]);

    expect(
      adapter.adapt(
        asMsg({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: '{"a":' },
          },
        })
      )
    ).toEqual([
      { type: "tool_input_delta", toolUseId: "tool-9", partialJson: '{"a":' },
    ]);
  });

  test("assistant tool_use block → tool_use_complete + thinking status", () => {
    const adapter = new StreamAdapter();
    const out = adapter.adapt(
      asMsg({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "ignored here" },
            { type: "tool_use", id: "tool-2", name: "Grep", input: { q: "x" } },
          ],
        },
      })
    );
    expect(out).toEqual([
      {
        type: "tool_use_complete",
        toolUseId: "tool-2",
        toolName: "Grep",
        input: { q: "x" },
      },
      { type: "status", status: "thinking" },
    ]);
  });

  test("user tool_result (string + array content) → tool_result", () => {
    const adapter = new StreamAdapter();
    expect(
      adapter.adapt(
        asMsg({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-3",
                content: "plain output",
                is_error: false,
              },
            ],
          },
        })
      )
    ).toEqual([
      { type: "tool_result", toolUseId: "tool-3", output: "plain output", isError: false },
    ]);

    expect(
      adapter.adapt(
        asMsg({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-4",
                content: [
                  { type: "text", text: "line1" },
                  { type: "text", text: "line2" },
                ],
                is_error: true,
              },
            ],
          },
        })
      )
    ).toEqual([
      { type: "tool_result", toolUseId: "tool-4", output: "line1\nline2", isError: true },
    ]);
  });

  test("result success → result + idle; error subtype → zeroed result", () => {
    const adapter = new StreamAdapter();
    expect(
      adapter.adapt(
        asMsg({
          type: "result",
          subtype: "success",
          session_id: "sess-1",
          total_cost_usd: 0.42,
          duration_ms: 1234,
          num_turns: 3,
        })
      )
    ).toEqual([
      {
        type: "result",
        sessionId: "sess-1",
        costUsd: 0.42,
        durationMs: 1234,
        numTurns: 3,
        isError: false,
      },
      { type: "status", status: "idle" },
    ]);

    expect(
      adapter.adapt(
        asMsg({
          type: "result",
          subtype: "error_max_turns",
          session_id: "sess-2",
        })
      )
    ).toEqual([
      {
        type: "result",
        sessionId: "sess-2",
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        isError: true,
      },
      { type: "status", status: "idle" },
    ]);
  });

  test("system init → thinking status; tool_progress → tool_executing", () => {
    const adapter = new StreamAdapter();
    expect(
      adapter.adapt(asMsg({ type: "system", subtype: "init" }))
    ).toEqual([
      { type: "status", status: "thinking", detail: "Session initialized" },
    ]);

    expect(
      adapter.adapt(
        asMsg({
          type: "tool_progress",
          tool_name: "Bash",
          elapsed_time_seconds: 2.6,
        })
      )
    ).toEqual([
      { type: "status", status: "tool_executing", detail: "Bash... (3s)" },
    ]);
  });
});

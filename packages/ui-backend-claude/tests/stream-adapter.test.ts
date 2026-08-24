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
      { type: "status", status: "idle" },
      {
        type: "result",
        sessionId: "sess-1",
        outcome: "success",
        costUsd: 0.42,
        durationMs: 1234,
        numTurns: 3,
        isError: false,
      },
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
      { type: "status", status: "idle" },
      {
        type: "result",
        sessionId: "sess-2",
        outcome: "error",
        durationMs: 0,
        numTurns: 0,
        isError: true,
        outcomeDetail: "max_turns",
      },
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

describe("StreamAdapter: subagent handling", () => {
  test("parent-tagged tool_use → linked start + complete, no thinking status", () => {
    const adapter = new StreamAdapter();
    const out = adapter.adapt(
      asMsg({
        type: "assistant",
        parent_tool_use_id: "agent-call-1",
        message: {
          content: [{ type: "tool_use", id: "sub-tool-1", name: "Read", input: { file: "x" } }],
        },
      })
    );
    expect(out).toEqual([
      {
        type: "tool_use_start",
        toolUseId: "sub-tool-1",
        toolName: "Read",
        parentToolUseId: "agent-call-1",
      },
      { type: "tool_use_complete", toolUseId: "sub-tool-1", toolName: "Read", input: { file: "x" } },
    ]);
  });

  test("parent-tagged text becomes a transcript activity event, never text_delta", () => {
    const events: unknown[] = [];
    const adapter = new StreamAdapter((e) => events.push(e));
    const out = adapter.adapt(
      asMsg({
        type: "assistant",
        parent_tool_use_id: "agent-call-1",
        message: { content: [{ type: "text", text: "subagent prose" }] },
      })
    );
    expect(out).toEqual([]);
    expect(events).toEqual([
      {
        kind: "subagent_transcript",
        toolUseId: "agent-call-1",
        role: "assistant",
        text: "subagent prose",
      },
    ]);
  });

  test("parent-tagged stream events are suppressed entirely", () => {
    const adapter = new StreamAdapter();
    const out = adapter.adapt(
      asMsg({
        type: "stream_event",
        parent_tool_use_id: "agent-call-1",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "spam" } },
      })
    );
    expect(out).toEqual([]);
  });

  test("task lifecycle messages report subagent activity with usage", () => {
    const events: any[] = [];
    const adapter = new StreamAdapter((e) => events.push(e));
    adapter.adapt(
      asMsg({
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        tool_use_id: "agent-call-1",
        description: "Compute 7*6",
        subagent_type: "general-purpose",
        is_backgrounded: false,
        spawn_depth: 1,
      })
    );
    adapter.adapt(
      asMsg({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        tool_use_id: "agent-call-1",
        status: "completed",
        summary: "42.",
        usage: { total_tokens: 20339, tool_uses: 0, duration_ms: 6561 },
      })
    );
    adapter.adapt(
      asMsg({
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: { status: "completed" },
      })
    );
    expect(events).toEqual([
      {
        kind: "subagent_started",
        toolUseId: "agent-call-1",
        taskId: "task-1",
        subagentType: "general-purpose",
        description: "Compute 7*6",
        depth: 1,
      },
      {
        kind: "subagent_status",
        toolUseId: "agent-call-1",
        status: "completed",
        usage: { totalTokens: 20339, toolUses: 0, durationMs: 6561 },
        summary: "42.",
      },
      { kind: "subagent_status", toolUseId: "agent-call-1", status: "completed" },
    ]);
  });

  test("a throwing activity reporter never fails the adapt call", () => {
    const adapter = new StreamAdapter(() => {
      throw new Error("reporter broken");
    });
    expect(() =>
      adapter.adapt(
        asMsg({
          type: "assistant",
          parent_tool_use_id: "p1",
          message: { content: [{ type: "text", text: "x" }] },
        })
      )
    ).not.toThrow();
  });
});

describe("StreamAdapter: result usage", () => {
  test("modelUsage maps to per-model breakdown with summed totals", () => {
    const adapter = new StreamAdapter();
    const out = adapter.adapt(
      asMsg({
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        total_cost_usd: 1.02,
        duration_ms: 9000,
        num_turns: 2,
        usage: { input_tokens: 4 },
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 8,
            outputTokens: 300,
            cacheReadInputTokens: 35712,
            cacheCreationInputTokens: 77571,
            costUSD: 1.02,
          },
        },
      })
    );
    const result = out.find((m) => m.type === "result") as any;
    expect(result.usage).toEqual({
      inputTokens: 8,
      outputTokens: 300,
      cacheReadTokens: 35712,
      cacheCreationTokens: 77571,
      perModel: {
        "claude-fable-5": {
          inputTokens: 8,
          outputTokens: 300,
          cacheReadTokens: 35712,
          cacheCreationTokens: 77571,
          costUsd: 1.02,
        },
      },
    });
  });

  test("error result carries real accounting and detail when present", () => {
    const adapter = new StreamAdapter();
    const out = adapter.adapt(
      asMsg({
        type: "result",
        subtype: "error_during_execution",
        session_id: "sess-1",
        total_cost_usd: 0.3,
        duration_ms: 5000,
        num_turns: 1,
        modelUsage: { "claude-fable-5": { inputTokens: 10, outputTokens: 5 } },
      })
    );
    const result = out.find((m) => m.type === "result") as any;
    expect(result.outcome).toBe("error");
    expect(result.outcomeDetail).toBe("execution");
    expect(result.costUsd).toBe(0.3);
    expect(result.durationMs).toBe(5000);
    expect(result.usage.perModel["claude-fable-5"].inputTokens).toBe(10);
  });
});

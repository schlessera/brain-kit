/**
 * This pins current behaviour so the 0.34.0 factory split can be proven
 * behaviour-preserving. Changing an assertion here is a behaviour change and
 * needs saying so.
 */

import { describe, expect, test } from "bun:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendBridge,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";

function makeBackend(gen: (options: Options) => AsyncGenerator<unknown>): {
  frames: ServerMessage[];
  start(signal?: AbortSignal): Promise<void>;
} {
  const frames: ServerMessage[] = [];
  const bridge: BackendBridge = {
    emit: (frame) => frames.push(frame),
    requestPermission: async () => ({ behavior: "allow" }),
  };
  const queryFn = ((params: { options?: Options }) =>
    gen(params.options!)) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: "/brain", queryFn });
  return {
    frames,
    start: (signal = new AbortController().signal) =>
      backend.startTurn({ prompt: "characterize stream", signal, bridge }),
  };
}

const init = (sessionId: string) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
});

describe("createClaudeBackend stream and usage characterization", () => {
  test("a scripted successful runtime produces the complete ordered frame stream", async () => {
    const harness = makeBackend(() =>
      (async function* () {
        yield init("claude-success");
        yield {
          type: "stream_event",
          session_id: "claude-success",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello" },
          },
        };
        yield {
          type: "stream_event",
          session_id: "claude-success",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "Check notes" },
          },
        };
        yield {
          type: "stream_event",
          session_id: "claude-success",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "read-1", name: "Read" },
          },
        };
        yield {
          type: "stream_event",
          session_id: "claude-success",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: '{"path":' },
          },
        };
        yield {
          type: "assistant",
          session_id: "claude-success",
          message: {
            content: [
              {
                type: "tool_use",
                id: "read-1",
                name: "Read",
                input: { path: "notes/a.md" },
              },
            ],
          },
        };
        yield {
          type: "user",
          session_id: "claude-success",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-1",
                content: "note body",
                is_error: false,
              },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "claude-success",
          total_cost_usd: 0.42,
          duration_ms: 1234,
          num_turns: 2,
          usage: { input_tokens: 9999 },
          modelUsage: {
            "claude-character-1": {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 20,
              cacheCreationInputTokens: 3,
              costUSD: 0.3,
            },
            "claude-character-2": {
              inputTokens: 4,
              outputTokens: 6,
              cacheReadInputTokens: 7,
              cacheCreationInputTokens: 2,
              costUSD: 0.11,
            },
          },
        };
      })()
    );

    await harness.start();

    expect(harness.frames).toEqual([
      {
        type: "session_info",
        sessionId: "claude-success",
        isNew: true,
        providerId: "claude",
        backendId: "claude",
      },
      {
        type: "status",
        status: "thinking",
        detail: "Session initialized",
        sessionId: "claude-success",
      },
      { type: "text_delta", text: "Hello", sessionId: "claude-success" },
      {
        type: "thinking_delta",
        text: "Check notes",
        sessionId: "claude-success",
      },
      {
        type: "tool_use_start",
        toolUseId: "read-1",
        toolName: "Read",
        sessionId: "claude-success",
      },
      {
        type: "tool_input_delta",
        toolUseId: "read-1",
        partialJson: '{"path":',
        sessionId: "claude-success",
      },
      {
        type: "tool_use_complete",
        toolUseId: "read-1",
        toolName: "Read",
        input: { path: "notes/a.md" },
        sessionId: "claude-success",
      },
      { type: "status", status: "thinking", sessionId: "claude-success" },
      {
        type: "tool_result",
        toolUseId: "read-1",
        output: "note body",
        isError: false,
        sessionId: "claude-success",
      },
      { type: "status", status: "idle", sessionId: "claude-success" },
      {
        type: "result",
        sessionId: "claude-success",
        outcome: "success",
        costUsd: 0.42,
        durationMs: 1234,
        numTurns: 2,
        isError: false,
        usage: {
          inputTokens: 14,
          outputTokens: 11,
          cacheReadTokens: 27,
          cacheCreationTokens: 5,
          perModel: {
            "claude-character-1": {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 20,
              cacheCreationTokens: 3,
              costUsd: 0.3,
            },
            "claude-character-2": {
              inputTokens: 4,
              outputTokens: 6,
              cacheReadTokens: 7,
              cacheCreationTokens: 2,
              costUsd: 0.11,
            },
          },
        },
      },
    ]);
  });

  test("an SDK error result preserves its real accounting", async () => {
    const harness = makeBackend(() =>
      (async function* () {
        yield init("claude-error-result");
        yield {
          type: "result",
          subtype: "error_max_budget_usd",
          session_id: "claude-error-result",
          total_cost_usd: 0.19,
          duration_ms: 222,
          num_turns: 3,
          modelUsage: {
            "claude-character-2": {
              inputTokens: 7,
              outputTokens: 2,
              costUSD: 0.18,
            },
          },
        };
      })()
    );

    await harness.start();

    expect(harness.frames.at(-1)).toEqual({
      type: "result",
      sessionId: "claude-error-result",
      outcome: "error",
      durationMs: 222,
      numTurns: 3,
      isError: true,
      outcomeDetail: "max_budget",
      costUsd: 0.19,
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        perModel: {
          "claude-character-2": {
            inputTokens: 7,
            outputTokens: 2,
            cacheReadTokens: undefined,
            cacheCreationTokens: undefined,
            costUsd: 0.18,
          },
        },
      },
    });
  });

  test("a truncated post-session stream emits an error and a zero-turn terminal result", async () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const harness = makeBackend(() =>
        (async function* () {
          yield init("claude-truncated");
          now = 1123;
        })()
      );

      await harness.start();

      expect(harness.frames).toEqual([
        {
          type: "session_info",
          sessionId: "claude-truncated",
          isNew: true,
          providerId: "claude",
          backendId: "claude",
        },
        {
          type: "status",
          status: "thinking",
          detail: "Session initialized",
          sessionId: "claude-truncated",
        },
        {
          type: "error",
          code: "CLAUDE_NO_RESULT",
          message: "Backend stream ended without a result",
          sessionId: "claude-truncated",
        },
        {
          type: "result",
          sessionId: "claude-truncated",
          outcome: "error",
          durationMs: 123,
          numTurns: 0,
          isError: true,
        },
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("a thrown post-session runtime error omits unknown cost and usage", async () => {
    const originalNow = Date.now;
    let now = 2000;
    Date.now = () => now;
    try {
      const harness = makeBackend(() =>
        (async function* () {
          yield init("claude-thrown");
          now = 2456;
          throw new Error("runtime disconnected");
        })()
      );

      await harness.start();

      expect(harness.frames.slice(-2)).toEqual([
        {
          type: "error",
          code: "CLAUDE_ERROR",
          message: "runtime disconnected",
          sessionId: "claude-thrown",
        },
        {
          type: "result",
          sessionId: "claude-thrown",
          outcome: "error",
          durationMs: 456,
          numTurns: 0,
          isError: true,
        },
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("a post-session abort resolves with cancelled status and unknown accounting omitted", async () => {
    const originalNow = Date.now;
    let now = 3000;
    Date.now = () => now;
    try {
      const harness = makeBackend((options) =>
        (async function* () {
          yield init("claude-abort");
          now = 3789;
          await new Promise<void>((_resolve, reject) => {
            options.abortController?.signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          });
        })()
      );
      const controller = new AbortController();
      const turn = harness.start(controller.signal);
      while (!harness.frames.some((frame) => frame.type === "session_info")) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      controller.abort();
      await turn;

      expect(harness.frames.slice(-2)).toEqual([
        { type: "status", status: "cancelled", sessionId: "claude-abort" },
        {
          type: "result",
          sessionId: "claude-abort",
          outcome: "cancelled",
          durationMs: 789,
          numTurns: 0,
          isError: false,
        },
      ]);
    } finally {
      Date.now = originalNow;
    }
  });
});

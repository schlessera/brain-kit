/**
 * This pins current behaviour so the 0.34.0 factory split can be proven
 * behaviour-preserving. Changing an assertion here is a behaviour change and
 * needs saying so.
 */

import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  BackendBridge,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/server";

import { createPiBackend, type PiSessionLike } from "../src/backend";
import { makeEmptyBrain } from "./helpers";

interface ScriptOptions {
  sessionId: string;
  costBefore: number;
  costAfter: number;
  events: AgentSessionEvent[];
  failure?: Error;
  waitForAbort?: boolean;
  advanceClock?: () => void;
  throwStatsAfter?: boolean;
}

function scriptedSession(options: ScriptOptions): {
  session: PiSessionLike;
  promptStarted: Promise<void>;
} {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let cost = options.costBefore;
  let finishPrompt: (() => void) | undefined;
  let statsCalls = 0;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    markPromptStarted = resolve;
  });

  const session: PiSessionLike = {
    sessionId: options.sessionId,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const event of options.events) {
        for (const listener of listeners) listener(event);
      }
      cost = options.costAfter;
      options.advanceClock?.();
      markPromptStarted();
      if (options.failure) throw options.failure;
      if (options.waitForAbort) {
        await new Promise<void>((resolve) => {
          finishPrompt = resolve;
        });
      }
    },
    async abort() {
      finishPrompt?.();
    },
    getSessionStats: () => {
      statsCalls += 1;
      if (options.throwStatsAfter && statsCalls > 1) {
        throw new Error("session stats unavailable");
      }
      return { cost };
    },
    dispose() {},
  };

  return { session, promptStarted };
}

function assistantUsageEvent(
  model: string,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  }
): AgentSessionEvent {
  return {
    type: "message_end",
    message: { role: "assistant", model, usage },
  } as unknown as AgentSessionEvent;
}

async function runTurn(
  session: PiSessionLike,
  signal = new AbortController().signal
): Promise<ServerMessage[]> {
  const frames: ServerMessage[] = [];
  const bridge: BackendBridge = {
    emit: (frame) => frames.push(frame),
    requestPermission: async () => ({ behavior: "allow" }),
  };
  const backend = createPiBackend({
    brainPath: "/brain",
    sessionFactory: {
      newSession: async () => session,
      openSession: async () => session,
    },
  });
  await backend.startTurn({ prompt: "characterize stream", signal, bridge });
  return frames;
}

describe("createPiBackend stream and usage characterization", () => {
  test("a scripted successful runtime produces the complete ordered frame stream", async () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const brain = makeEmptyBrain();
      try {
        const { session } = scriptedSession({
          sessionId: "pi-success",
          costBefore: 4,
          costAfter: 4.5,
          events: [
            {
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "Hello",
                contentIndex: 0,
              },
            } as unknown as AgentSessionEvent,
            {
              type: "message_update",
              assistantMessageEvent: {
                type: "thinking_delta",
                delta: "Check notes",
                contentIndex: 0,
              },
            } as unknown as AgentSessionEvent,
            {
              type: "tool_execution_start",
              toolCallId: "read-1",
              toolName: "read_file",
              args: { path: "notes/a.md" },
            } as unknown as AgentSessionEvent,
            {
              type: "tool_execution_end",
              toolCallId: "read-1",
              toolName: "read_file",
              result: {
                content: [{ type: "text", text: "note body" }],
                details: null,
              },
              isError: false,
            } as unknown as AgentSessionEvent,
            assistantUsageEvent("anthropic/pi-character-1", {
              input: 10,
              output: 5,
              cacheRead: 20,
              cacheWrite: 3,
              cost: { total: 0.125 },
            }),
            assistantUsageEvent("openai/pi-character-2", {
              input: 4,
              output: 6,
              cacheRead: 7,
              cacheWrite: 2,
              cost: { total: 0.0625 },
            }),
            assistantUsageEvent("anthropic/pi-character-1", {
              input: 2,
              output: 3,
              cacheRead: 1,
              cacheWrite: 4,
              cost: { total: 0.25 },
            }),
          ],
          advanceClock: () => {
            now = 1321;
          },
        });
        const frames: ServerMessage[] = [];
        const bridge: BackendBridge = {
          emit: (frame) => frames.push(frame),
          requestPermission: async () => ({ behavior: "allow" }),
        };
        const backend = createPiBackend({
          brainPath: brain.root,
          sessionFactory: {
            newSession: async () => session,
            openSession: async () => session,
          },
        });

        await backend.startTurn({
          prompt: "characterize stream",
          signal: new AbortController().signal,
          bridge,
        });

        expect(frames).toEqual([
          {
            type: "session_info",
            sessionId: "pi-success",
            isNew: true,
            backendId: "pi",
          },
          { type: "status", status: "thinking", sessionId: "pi-success" },
          { type: "text_delta", text: "Hello", sessionId: "pi-success" },
          {
            type: "thinking_delta",
            text: "Check notes",
            sessionId: "pi-success",
          },
          {
            type: "tool_use_start",
            toolUseId: "read-1",
            toolName: "read_file",
            sessionId: "pi-success",
          },
          {
            type: "tool_use_complete",
            toolUseId: "read-1",
            toolName: "read_file",
            input: { path: "notes/a.md" },
            sessionId: "pi-success",
          },
          { type: "status", status: "tool_executing", sessionId: "pi-success" },
          {
            type: "tool_result",
            toolUseId: "read-1",
            output: "note body",
            isError: false,
            sessionId: "pi-success",
          },
          { type: "status", status: "idle", sessionId: "pi-success" },
          {
            type: "result",
            sessionId: "pi-success",
            outcome: "success",
            costUsd: 0.5,
            usage: {
              inputTokens: 16,
              outputTokens: 14,
              cacheReadTokens: 28,
              cacheCreationTokens: 9,
              perModel: {
                "anthropic/pi-character-1": {
                  inputTokens: 12,
                  outputTokens: 8,
                  cacheReadTokens: 21,
                  cacheCreationTokens: 7,
                  costUsd: 0.375,
                },
                "openai/pi-character-2": {
                  inputTokens: 4,
                  outputTokens: 6,
                  cacheReadTokens: 7,
                  cacheCreationTokens: 2,
                  costUsd: 0.0625,
                },
              },
            },
            durationMs: 321,
            numTurns: 1,
            isError: false,
          },
        ]);
      } finally {
        brain.cleanup();
      }
    } finally {
      Date.now = originalNow;
    }
  });

  test("a runtime failure keeps the session-cost delta and observed token usage", async () => {
    const originalNow = Date.now;
    let now = 2000;
    Date.now = () => now;
    try {
      const { session } = scriptedSession({
        sessionId: "pi-error",
        costBefore: 8,
        costAfter: 8.25,
        events: [
          assistantUsageEvent("openai/pi-character-2", {
            input: 4,
            output: 2,
            cacheRead: 0,
            cacheWrite: 1,
            cost: { total: 0.2 },
          }),
        ],
        failure: new Error("provider unavailable"),
        advanceClock: () => {
          now = 2654;
        },
      });

      const frames = await runTurn(session);

      expect(frames.slice(-3)).toEqual([
        {
          type: "error",
          code: "agent_error",
          message: "provider unavailable",
          sessionId: "pi-error",
        },
        { type: "status", status: "idle", sessionId: "pi-error" },
        {
          type: "result",
          sessionId: "pi-error",
          outcome: "error",
          costUsd: 0.25,
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheCreationTokens: 1,
            perModel: {
              "openai/pi-character-2": {
                inputTokens: 4,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheCreationTokens: 1,
                costUsd: 0.2,
              },
            },
          },
          durationMs: 654,
          numTurns: 1,
          isError: true,
          // Behaviour change (#575): the terminal frame carries the failure
          // the diagnostic error reported, normalised. The error frame above
          // is unchanged, so an older client shows what it always did.
          failure: { errorClass: "unknown", message: "provider unavailable" },
        },
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("an aborted turn keeps paid usage and reports a non-error cancellation", async () => {
    const originalNow = Date.now;
    let now = 3000;
    Date.now = () => now;
    try {
      const { session, promptStarted } = scriptedSession({
        sessionId: "pi-abort",
        costBefore: 12,
        costAfter: 12.5,
        events: [
          assistantUsageEvent("google/pi-character-3", {
            input: 9,
            output: 1,
            cacheRead: 2,
            cacheWrite: 0,
            cost: { total: 0.35 },
          }),
        ],
        waitForAbort: true,
        advanceClock: () => {
          now = 3987;
        },
      });
      const frames: ServerMessage[] = [];
      const bridge: BackendBridge = {
        emit: (frame) => frames.push(frame),
        requestPermission: async () => ({ behavior: "allow" }),
      };
      const backend = createPiBackend({
        brainPath: "/brain",
        sessionFactory: {
          newSession: async () => session,
          openSession: async () => session,
        },
      });
      const controller = new AbortController();
      const turn = backend.startTurn({
        prompt: "characterize abort",
        signal: controller.signal,
        bridge,
      });
      await promptStarted;

      controller.abort();
      await turn;

      expect(frames.slice(-2)).toEqual([
        { type: "status", status: "cancelled", sessionId: "pi-abort" },
        {
          type: "result",
          sessionId: "pi-abort",
          outcome: "cancelled",
          costUsd: 0.5,
          usage: {
            inputTokens: 9,
            outputTokens: 1,
            cacheReadTokens: 2,
            cacheCreationTokens: 0,
            perModel: {
              "google/pi-character-3": {
                inputTokens: 9,
                outputTokens: 1,
                cacheReadTokens: 2,
                cacheCreationTokens: 0,
                costUsd: 0.35,
              },
            },
          },
          durationMs: 987,
          numTurns: 1,
          isError: false,
        },
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("a negative session-cost delta is clamped to zero", async () => {
    const originalNow = Date.now;
    let now = 4000;
    Date.now = () => now;
    try {
      const { session } = scriptedSession({
        sessionId: "pi-reset-cost",
        costBefore: 5,
        costAfter: 3,
        events: [],
        advanceClock: () => {
          now = 4111;
        },
      });

      const frames = await runTurn(session);

      expect(frames.at(-1)).toEqual({
        type: "result",
        sessionId: "pi-reset-cost",
        outcome: "success",
        costUsd: 0,
        durationMs: 111,
        numTurns: 1,
        isError: false,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("an unavailable before-turn cost snapshot omits cost instead of reporting zero", async () => {
    const originalNow = Date.now;
    let now = 5000;
    Date.now = () => now;
    try {
      const { session } = scriptedSession({
        sessionId: "pi-unknown-cost",
        costBefore: Number.NaN,
        costAfter: 3,
        events: [],
        advanceClock: () => {
          now = 5222;
        },
      });

      const frames = await runTurn(session);

      expect(frames.at(-1)).toEqual({
        type: "result",
        sessionId: "pi-unknown-cost",
        outcome: "success",
        durationMs: 222,
        numTurns: 1,
        isError: false,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("an unavailable after-turn cost snapshot omits cost instead of reporting zero", async () => {
    const originalNow = Date.now;
    let now = 6000;
    Date.now = () => now;
    try {
      const { session } = scriptedSession({
        sessionId: "pi-unknown-after-cost",
        costBefore: 3,
        costAfter: Number.NaN,
        events: [],
        advanceClock: () => {
          now = 6333;
        },
      });

      const frames = await runTurn(session);

      expect(frames.at(-1)).toEqual({
        type: "result",
        sessionId: "pi-unknown-after-cost",
        outcome: "success",
        durationMs: 333,
        numTurns: 1,
        isError: false,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("throwing session stats omit cost and do not fail the turn", async () => {
    const originalNow = Date.now;
    let now = 7000;
    Date.now = () => now;
    try {
      const { session } = scriptedSession({
        sessionId: "pi-throwing-stats",
        costBefore: 9,
        costAfter: 9.75,
        events: [],
        throwStatsAfter: true,
        advanceClock: () => {
          now = 7444;
        },
      });

      const frames = await runTurn(session);

      expect(frames.at(-1)).toEqual({
        type: "result",
        sessionId: "pi-throwing-stats",
        outcome: "success",
        durationMs: 444,
        numTurns: 1,
        isError: false,
      });
    } finally {
      Date.now = originalNow;
    }
  });
});

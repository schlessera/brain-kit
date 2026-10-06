/**
 * The runner's side of mid-turn follow-ups (#1003), against a double of the
 * SDK query: what is written into the running turn's input, when the turn
 * refuses one, and how the turn's one terminal frame is built when the CLI
 * runs a follow-up as a continuation. What the real CLI does with the
 * message is `follow-up-delivery.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendBridge, ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { defineProfiles } from "../src/profiles";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** A profile with its own key, so no subscription gate runs. */
const profiles = defineProfiles([{ id: "api", label: "API", apiKeyEnv: "FOLLOW_UP_TEST_KEY", source: "declared" }]);
process.env.FOLLOW_UP_TEST_KEY = "sk-ant-api03-test";

interface Script {
  /** Runs once the turn's first message was read; yields what the CLI would. */
  (input: AsyncIterator<SDKUserMessage>): AsyncGenerator<unknown>;
}

function harness(script: Script, extra: Partial<StartTurnRequest> = {}) {
  const frames: ServerMessage[] = [];
  const first: SDKUserMessage[] = [];
  let sessionReady!: () => void;
  const ready = new Promise<void>((resolve) => (sessionReady = resolve));
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => ({
    async *[Symbol.asyncIterator]() {
      const input = params.prompt[Symbol.asyncIterator]();
      const opening = await input.next();
      if (!opening.done) first.push(opening.value);
      yield* script(input);
    },
  })) as unknown as typeof query;
  const bridge: BackendBridge = {
    emit: (frame) => {
      frames.push(frame);
      if (frame.type === "session_info") sessionReady();
    },
    requestPermission: async () => ({ behavior: "allow" }),
  };
  const backend = createClaudeBackend({ brainPath: "/brain", profiles, queryFn, log: () => {} });
  const start = () =>
    backend.startTurn({ prompt: "Plan the voyage home.", signal: new AbortController().signal, bridge, ...extra });
  return { backend, frames, first, ready, start };
}

const init = { type: "system", subtype: "init", session_id: "voyage" };
function result(numTurns: number, durationMs: number, cost: number, text = "done") {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "voyage",
    result: text,
    num_turns: numTurns,
    duration_ms: durationMs,
    total_cost_usd: cost,
  };
}
const lifecycle = (uuid: string | undefined, state: string) => ({
  type: "command_lifecycle",
  command_uuid: uuid,
  state,
  session_id: "voyage",
});

describe("delivering a follow-up into the running turn", () => {
  test("writes it into the turn's input as a next-priority user message, with its images", async () => {
    let followUp: SDKUserMessage | undefined;
    let resume!: () => void;
    const delivered = new Promise<void>((resolve) => (resume = resolve));
    const h = harness(async function* (input) {
      yield init;
      const next = await input.next();
      followUp = next.done ? undefined : next.value;
      await delivered;
      yield lifecycle(followUp?.uuid, "queued");
      yield lifecycle(followUp?.uuid, "started");
      yield lifecycle(followUp?.uuid, "completed");
      yield result(2, 10, 0.01);
    });
    const turn = h.start();
    await h.ready;
    await h.backend.followUp!({
      sessionId: "voyage",
      prompt: "Also check the harbour log.",
      attachments: [{ mediaType: "image/png", data: PNG_1PX }],
    });
    resume();
    await turn;

    expect(h.first[0]?.message.content).toBe("Plan the voyage home.");
    expect(followUp).toMatchObject({
      type: "user",
      parent_tool_use_id: null,
      priority: "next",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Also check the harbour log." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } },
        ],
      },
    });
    expect(typeof followUp?.uuid).toBe("string");
    // Taken in by the turn itself: its own result is the terminal frame.
    expect(h.frames.filter((frame) => frame.type === "result")).toEqual([
      expect.objectContaining({ numTurns: 2, durationMs: 10, costUsd: 0.01 }),
    ]);
  });

  test("a resumed turn takes one from the moment startTurn is called", async () => {
    // The host offers a live follow-up as soon as it has handed the turn to
    // startTurn (#1063), before anything the turn awaits. The runner must
    // already hold the session's input by then, or the message is refused.
    let followUp: SDKUserMessage | undefined;
    const h = harness(
      async function* (input) {
        yield init;
        const next = await input.next();
        followUp = next.done ? undefined : next.value;
        yield lifecycle(followUp?.uuid, "queued");
        yield lifecycle(followUp?.uuid, "started");
        yield lifecycle(followUp?.uuid, "completed");
        yield result(2, 10, 0.01);
      },
      { sessionId: "voyage" }
    );
    const turn = h.start();
    const delivery = h.backend.followUp!({ sessionId: "voyage", prompt: "Mind the Cyclops." });
    delivery.catch(() => {});
    await expect(delivery).resolves.toBeUndefined();
    await turn;

    expect(followUp?.message.content).toBe("Mind the Cyclops.");
  });

  test("is refused for an autonomous run, which is not a conversation", async () => {
    let refusal: Promise<void> | undefined;
    let identified!: () => void;
    const identity = new Promise<void>((resolve) => (identified = resolve));
    const h = harness(
      async function* () {
        yield init;
        await identity;
        refusal = h.backend.followUp!({ sessionId: "voyage", prompt: "Steer the run." });
        refusal.catch(() => {});
        yield result(1, 5, 0);
      },
      {
        enforceAllowedTools: true,
        noGrantSurface: true,
        autonomous: { origin: "autonomous", persistence: "none", allowedTools: ["Read"], systemPromptAppend: "" },
        bridge: {
          emit: () => {},
          checkpointPermission: () => {},
          requestPermission: async () => ({ behavior: "deny", message: "No grant surface" }),
          activity: (event) => {
            if (event.kind === "autonomous_identity") identified();
          },
        },
      }
    );
    await h.start();

    expect(refusal).toBeDefined();
    await expect(refusal!).rejects.toBeInstanceOf(BackendRequestError);
  });

  test("an autonomous run's input still ends when the run ends without a result", async () => {
    let input: AsyncIterator<SDKUserMessage> | undefined;
    const h = harness(
      async function* (stream) {
        input = stream;
        yield init;
        // The CLI dies: no result.
      },
      {
        enforceAllowedTools: true,
        noGrantSurface: true,
        autonomous: { origin: "autonomous", persistence: "none", allowedTools: ["Read"], systemPromptAppend: "" },
        bridge: {
          emit: () => {},
          checkpointPermission: () => {},
          requestPermission: async () => ({ behavior: "deny", message: "No grant surface" }),
        },
      }
    );
    await h.start();

    expect(input).toBeDefined();
    const next = await Promise.race([input!.next(), Bun.sleep(500).then(() => "still open" as const)]);
    expect(next).toEqual({ done: true, value: undefined });
  });

  test("is refused once the turn has ended", async () => {
    const h = harness(async function* () {
      yield init;
      yield result(1, 5, 0);
    });
    await h.start();

    const refusal = h.backend.followUp!({ sessionId: "voyage", prompt: "Too late." });
    await expect(refusal).rejects.toBeInstanceOf(BackendRequestError);
  });

  test("is refused after the turn's result, while its stream is still draining", async () => {
    let refusal: Promise<void> | undefined;
    const h = harness(async function* () {
      yield init;
      yield result(1, 5, 0);
      refusal = h.backend.followUp!({ sessionId: "voyage", prompt: "After the end." });
      refusal.catch(() => {});
    });
    await h.start();

    expect(refusal).toBeDefined();
    await expect(refusal!).rejects.toBeInstanceOf(BackendRequestError);
  });
});

describe("a follow-up the CLI runs after the turn's last step", () => {
  test("the turn ends on one result, counting both runs", async () => {
    let resume!: () => void;
    const delivered = new Promise<void>((resolve) => (resume = resolve));
    const h = harness(async function* (input) {
      yield init;
      const next = await input.next();
      const uuid = next.done ? undefined : next.value.uuid;
      await delivered;
      yield lifecycle(uuid, "queued");
      yield result(3, 40, 0.02, "first");
      yield lifecycle(uuid, "started");
      yield init;
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "and the log" } } };
      yield lifecycle(uuid, "completed");
      // Cost is cumulative over the process; turns and duration are per run.
      yield result(1, 5, 0.03, "second");
      // The input closed on the last result, so the CLI's stream ends here.
      expect((await input.next()).done).toBe(true);
    });
    const turn = h.start();
    await h.ready;
    await h.backend.followUp!({ sessionId: "voyage", prompt: "Also check the harbour log." });
    resume();
    await turn;

    const results = h.frames.filter((frame) => frame.type === "result");
    expect(results).toEqual([expect.objectContaining({ outcome: "success", numTurns: 4, durationMs: 45, costUsd: 0.03 })]);
    expect(h.frames.at(-1)).toBe(results[0]!);
    expect(h.frames.some((frame) => frame.type === "text_delta" && frame.text === "and the log")).toBe(true);
  });

  test("a continuation that ends without its result fails the turn, not the held success", async () => {
    let resume!: () => void;
    const delivered = new Promise<void>((resolve) => (resume = resolve));
    const h = harness(async function* (input) {
      yield init;
      const next = await input.next();
      const uuid = next.done ? undefined : next.value.uuid;
      await delivered;
      yield lifecycle(uuid, "queued");
      yield result(3, 40, 0.02, "first");
      yield lifecycle(uuid, "started");
      yield init;
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "and the" } } };
      // The CLI dies mid-continuation: no second result.
    });
    const turn = h.start();
    await h.ready;
    await h.backend.followUp!({ sessionId: "voyage", prompt: "Also check the harbour log." });
    resume();
    await turn;

    expect(h.frames.some((frame) => frame.type === "error" && frame.code === "CLAUDE_NO_RESULT")).toBe(true);
    const results = h.frames.filter((frame) => frame.type === "result");
    expect(results).toEqual([expect.objectContaining({ outcome: "error" })]);
    expect(h.frames.at(-1)).toBe(results[0]!);
  });

  test("a held result still ends the turn when no continuation comes", async () => {
    let resume!: () => void;
    const delivered = new Promise<void>((resolve) => (resume = resolve));
    const h = harness(async function* (input) {
      yield init;
      await input.next();
      await delivered;
      // A runtime that never reports the follow-up: no lifecycle frames.
      yield result(2, 20, 0.01);
      // Unacknowledged past the grace, the follow-up closes the input, so the CLI can exit.
      expect((await input.next()).done).toBe(true);
    });
    const turn = h.start();
    await h.ready;
    await h.backend.followUp!({ sessionId: "voyage", prompt: "Also check the harbour log." });
    resume();
    await turn;

    const results = h.frames.filter((frame) => frame.type === "result");
    expect(results).toEqual([expect.objectContaining({ outcome: "success", numTurns: 2, durationMs: 20 })]);
    expect(h.frames.at(-1)).toBe(results[0]!);
  });
});

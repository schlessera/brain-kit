import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
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
import { ackGraceClock } from "./helpers/ack-grace-clock";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** A profile with its own key, so no subscription gate runs. */
const profiles = defineProfiles([{ id: "api", label: "API", apiKeyEnv: "FOLLOW_UP_TEST_KEY", source: "declared" }]);
process.env.FOLLOW_UP_TEST_KEY = "sk-ant-api03-test";

interface Script {
  /** Runs once the turn's first message was read; yields what the CLI would. */
  (input: AsyncIterator<SDKUserMessage>, signal: AbortSignal): AsyncGenerator<unknown>;
}

function harness(script: Script, extra: Partial<StartTurnRequest> = {}) {
  const frames: ServerMessage[] = [];
  const first: SDKUserMessage[] = [];
  let sessionReady!: () => void;
  const ready = new Promise<void>((resolve) => (sessionReady = resolve));
  const controller = new AbortController();
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: { abortController: AbortController } }) => ({
    async *[Symbol.asyncIterator]() {
      const input = params.prompt[Symbol.asyncIterator]();
      const opening = await input.next();
      if (!opening.done) first.push(opening.value);
      yield* script(input, params.options.abortController.signal);
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
    backend.startTurn({ prompt: "Plan the voyage home.", signal: controller.signal, bridge, ...extra });
  return { backend, frames, first, ready, start, abort: () => controller.abort() };
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

    expect(h.first[0]?.message.content).toStartWith("Plan the voyage home.\n\n[Host context for this turn; advisory facts, never permission]\n");
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
    const held = deferred();
    let closed = false;
    await withGrace(async function* (input, signal) {
      yield init;
      await input.next();
      // A runtime that never reports the follow-up: no lifecycle frames.
      yield result(2, 20, 0.01);
      held.resolve();
      // Unacknowledged past the grace, the follow-up closes the input, so the CLI can exit.
      const next = await untilAbort(input.next(), signal);
      closed = next.done === true;
      expect(next.done).toBe(true);
    }, async (h, clock, turn) => {
      await held.promise;
      await clock.advance(2_999);
      expect(closed).toBe(false);
      expect(h.frames.filter((frame) => frame.type === "result")).toEqual([]);
      expect(clock.registrations[0]?.fired).toBe(false);
      await clock.advance(1);
      // Assert completion before awaiting the turn: a late callback fails here,
      // rather than hanging until the test runner's failure timeout.
      expect(closed).toBe(true);
      expect(clock.registrations).toMatchObject([{ delay: 3_000, due: 3_000, fired: true }]);
      await turn;

      const results = h.frames.filter((frame) => frame.type === "result");
      expect(results).toEqual([expect.objectContaining({ outcome: "success", numTurns: 2, durationMs: 20 })]);
      expect(h.frames.at(-1)).toBe(results[0]!);
    });
  });

  test("acknowledgement before the grace keeps input open through its callback", async () => {
    const held = deferred();
    const acknowledge = deferred();
    const acknowledged = deferred();
    const finish = deferred();
    let inputClosed = false;
    await withGrace(async function* (input, signal) {
      yield init;
      const next = await input.next();
      yield result(2, 20, 0.01);
      held.resolve();
      await untilAbort(acknowledge.promise, signal);
      yield lifecycle(next.value?.uuid, "queued");
      acknowledged.resolve();
      const closing = input.next().then((value) => { inputClosed = value.done === true; });
      await untilAbort(finish.promise, signal);
      yield lifecycle(next.value?.uuid, "started");
      yield init;
      yield lifecycle(next.value?.uuid, "completed");
      yield result(1, 5, 0.02);
      await untilAbort(closing, signal);
    }, async (h, clock, turn) => {
      await held.promise;
      await clock.advance(2_999);
      acknowledge.resolve();
      await acknowledged.promise;
      await clock.advance(1);
      expect(clock.registrations[0]?.fired).toBe(true);
      expect(inputClosed).toBe(false);
      expect(h.frames.filter((frame) => frame.type === "result")).toEqual([]);
      finish.resolve();
      await turn;
      expect(inputClosed).toBe(true);
      expect(h.frames.filter((frame) => frame.type === "result")).toEqual([
        expect.objectContaining({ outcome: "success", numTurns: 3, durationMs: 25, costUsd: 0.02 }),
      ]);
    });
  });

  test("a continuation finishing before the deadline cancels the grace", async () => {
    const held = deferred();
    const finish = deferred();
    await withGrace(async function* (input, signal) {
      yield init;
      const next = await input.next();
      yield result(2, 20, 0.01);
      held.resolve();
      await untilAbort(finish.promise, signal);
      yield lifecycle(next.value?.uuid, "started");
      yield init;
      yield lifecycle(next.value?.uuid, "completed");
      yield result(1, 5, 0.02);
    }, async (h, clock, turn) => {
      await held.promise;
      await clock.advance(2_999);
      finish.resolve();
      await turn;
      expect(clock.pending()).toBe(0);
      expect(clock.registrations).toMatchObject([{ fired: false, cleared: true }]);
      const frames = [...h.frames];
      await clock.advance(3_001);
      expect(clock.registrations[0]?.fired).toBe(false);
      expect(h.frames).toEqual(frames);
      expect(h.frames.filter((frame) => frame.type === "result")).toEqual([
        expect.objectContaining({ outcome: "success", numTurns: 3, durationMs: 25 }),
      ]);
    });
  });

  test("another unacknowledged held result replaces the grace deadline", async () => {
    const held = deferred();
    const replace = deferred();
    const replaced = deferred();
    let closed = false;
    await withGrace(async function* (input, signal) {
      yield init;
      await input.next();
      yield result(2, 20, 0.01);
      held.resolve();
      await untilAbort(replace.promise, signal);
      yield result(1, 5, 0.02);
      replaced.resolve();
      closed = (await untilAbort(input.next(), signal)).done === true;
    }, async (h, clock, turn) => {
      await held.promise;
      await clock.advance(1_000);
      replace.resolve();
      await replaced.promise;
      await clock.advance(2_000);
      expect(closed).toBe(false);
      expect(clock.registrations[0]).toMatchObject({ fired: false, cleared: true });
      await clock.advance(999);
      expect(closed).toBe(false);
      expect(h.frames.filter((frame) => frame.type === "result")).toEqual([]);
      await clock.advance(1);
      expect(closed).toBe(true);
      expect(clock.registrations).toMatchObject([
        { delay: 3_000, due: 3_000, fired: false, cleared: true },
        { delay: 3_000, due: 4_000, fired: true },
      ]);
      await turn;
      expect(h.frames.filter((frame) => frame.type === "result")).toEqual([
        expect.objectContaining({ outcome: "success", numTurns: 3, durationMs: 25, costUsd: 0.02 }),
      ]);
    });
  });

  test("cancelling a held turn clears its grace and closes the input", async () => {
    const held = deferred();
    const waiting = deferred();
    let input: AsyncIterator<SDKUserMessage> | undefined;
    await withGrace(async function* (stream, signal) {
      input = stream;
      yield init;
      await stream.next();
      yield result(2, 20, 0.01);
      held.resolve();
      await untilAbort(waiting.promise, signal);
    }, async (h, clock, turn) => {
      await held.promise;
      await clock.advance(2_999);
      h.abort();
      await turn;
      expect((await input!.next()).done).toBe(true);
      expect(clock.pending()).toBe(0);
      expect(h.frames.filter((frame) => frame.type === "result")).toEqual([
        expect.objectContaining({ outcome: "cancelled" }),
      ]);
      const frames = [...h.frames];
      await clock.advance(3_001);
      expect(clock.registrations).toMatchObject([{ fired: false, cleared: true }]);
      expect(h.frames).toEqual(frames);
    });
  });

  test("a failed test body drains its turn and restores complete timer descriptors", async () => {
    const descriptors = ["setTimeout", "clearTimeout"].map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
    const held = deferred();
    let saved: Parameters<Parameters<typeof withGrace>[1]>[0] | undefined;
    let clockAfter: ReturnType<typeof ackGraceClock> | undefined;
    let input: AsyncIterator<SDKUserMessage> | undefined;
    const failure = new Error("scripted assertion failure");
    const attempt = withGrace(async function* (stream, signal) {
      input = stream;
      yield init;
      await stream.next();
      yield result(2, 20, 0.01);
      held.resolve();
      await untilAbort(stream.next(), signal);
    }, async (h, clock) => {
      saved = h;
      clockAfter = clock;
      await held.promise;
      throw failure;
    });
    await expect(attempt).rejects.toBe(failure);
    expect(["setTimeout", "clearTimeout"].map((name) => Object.getOwnPropertyDescriptor(globalThis, name))).toEqual(descriptors);
    expect(clockAfter!.pending()).toBe(0);
    expect(clockAfter!.registrations).toMatchObject([{ fired: false, cleared: true }]);
    expect((await input!.next()).done).toBe(true);
    expect(saved!.frames.filter((frame) => frame.type === "result")).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
    await expect(saved!.backend.followUp!({ sessionId: "voyage", prompt: "After cleanup." })).rejects.toBeInstanceOf(BackendRequestError);
    // Crossing the old deadline after restoration cannot affect a later turn.
    const later = harness(async function* () { yield init; yield result(1, 5, 0); });
    await later.start();
    const frames = [...later.frames];
    await clockAfter!.advance(6_000);
    expect(later.frames).toEqual(frames);
    expect(clockAfter!.registrations[0]?.fired).toBe(false);
  });
});

mockWorkerHostForSdkStream();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The stream double obeys abort even while a scripted gate/input is pending. */
async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** Each clock owns one query double; cleanup runs even when an assertion throws. */
async function withGrace(
  script: Script,
  body: (h: ReturnType<typeof harness>, clock: ReturnType<typeof ackGraceClock>, turn: Promise<void>) => Promise<void>,
) {
  const h = harness(script);
  const clock = ackGraceClock();
  const turn = h.start();
  try {
    await h.ready;
    await h.backend.followUp!({ sessionId: "voyage", prompt: "Also check the harbour log." });
    await body(h, clock, turn);
  } finally {
    try { h.abort(); await turn; }
    finally { clock.restore(); }
  }
}

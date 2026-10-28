/**
 * Live-conversation host orchestration (#957), driven through the real socket
 * handlers, the real session queue and a keyless provider whose events and
 * deferred results the test sequences by hand. The backend's turns wait on a
 * gate the test opens, so cancellation, withdrawal and epoch replacement land
 * while work is genuinely pending — and the backend then answers anyway, as a
 * late callback would.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { CONVERSATION_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { ConversationHost } from "../src/ws/conversation";
import { makeFakeBackend } from "./helpers/fake-backend";
import { fakeLiveProvider, SILENCE, type FakeLiveSession } from "./helpers/live-conversation";
import { testPrincipal } from "./helpers/principal";

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 25));

interface Turn {
  req: StartTurnRequest;
  sessionId: string;
  /** Let the backend answer: one text delta, then a success result. */
  answer: (text: string) => void;
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function setup(options: {
  capabilities?: Parameters<typeof fakeLiveProvider>[0];
  conversation?: boolean;
  authorized?: boolean;
  holdReturns?: boolean;
  turnTimeoutMs?: number;
  wsRate?: { ratePerSecond: number; burst: number };
  /** Replace the backend's profile listing (routing awaits it for a known session). */
  listProfiles?: () => Promise<{ id: string; label: string }[]>;
} = {}) {
  const db = createUiDb(":memory:");
  const live = fakeLiveProvider(options.capabilities, { holdReturns: options.holdReturns === true });
  const turns: Turn[] = [];
  let sessionCount = 0;
  const backend = makeFakeBackend({
    id: "fake",
    startTurn: async (req) => {
      const sessionId = req.sessionId ?? `sess-ithaca-${++sessionCount}`;
      req.bridge.emit({ type: "session_info", sessionId, isNew: req.sessionId === undefined });
      // Deliberately ignores the abort signal: the answer arrives whenever
      // the test says, which is how a late callback looks to the host.
      const text = await new Promise<string>((resolve) => turns.push({ req, sessionId, answer: resolve }));
      req.bridge.emit({ type: "text_delta", text });
      req.bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    },
  });
  if (options.listProfiles) backend.listProfiles = options.listProfiles;
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    ...(options.authorized ? { isPrincipalAuthorized: () => true } : {}),
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.wsRate ? { wsRate: options.wsRate } : {}),
    ...(options.conversation === false ? {} : { conversationProvider: live.provider }),
  });
  cleanup = () => {
    for (const turn of turns) turn.answer("");
    host.coordinator.reset();
    host.close();
    db.close();
  };

  async function connect() {
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (data: string) => sent.push(data) } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    let sequence = 0;
    const frames = (type?: string): any[] =>
      sent.map((s) => JSON.parse(s)).filter((f) => type === undefined || f.type === type);
    const send = (frame: Record<string, unknown>) =>
      handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
    /** Frames of `type` sent after the latest `conversation_opened`. */
    const sinceOpened = (type: string): any[] => {
      const all = sent.map((s) => JSON.parse(s));
      const at = all.map((f) => f.type).lastIndexOf("conversation_opened");
      return all.slice(at + 1).filter((f) => f.type === type);
    };
    return {
      ws,
      frames,
      sinceOpened,
      send,
      close: () => handlers.onClose({ code: 1000 } as CloseEvent, ws),
      /** Open (or resume) a conversation and wait for its epoch. */
      async open(extra: Record<string, unknown> = {}) {
        // Audio sequences restart at 0 in every epoch.
        sequence = 0;
        const before = frames("conversation_opened").length;
        send({ type: "conversation_start", ...extra });
        await until(() => frames("conversation_opened").length > before);
        const opened = frames("conversation_opened").at(-1);
        return { id: opened.conversationId as string, epoch: opened.epoch as number, session: live.sessions.at(-1)! as FakeLiveSession, opened };
      },
      async capture(conversation: { id: string; epoch: number; session: FakeLiveSession }, utteranceId = "context-capture") {
        send({ type: "conversation_audio", conversationId: conversation.id, epoch: conversation.epoch, utteranceId, sequence: sequence++, rate: 16_000, pcm: SILENCE });
        await until(() => conversation.session.audio.some(chunk => chunk.utteranceId === utteranceId));
      },
      /** Capture one utterance and have the provider recognize it. */
      async speak(conversation: { id: string; epoch: number; session: FakeLiveSession }, utteranceId: string, text: string, origin: "user" | "assistant" | "unknown" = "user") {
        send({ type: "conversation_audio", conversationId: conversation.id, epoch: conversation.epoch, utteranceId, sequence: sequence++, rate: 16_000, pcm: SILENCE });
        await until(() => conversation.session.audio.some((chunk) => chunk.utteranceId === utteranceId));
        const seen = frames("conversation_event").length;
        conversation.session.emit({ kind: "input_fragment", utteranceId, sequence: 0, text, finalization: "unknown", certainty: "unknown", origin });
        await until(() => frames("conversation_event").length > seen);
      },
      commit(conversation: { id: string; epoch: number }, utteranceId: string, requestId: string, text: string) {
        send({ type: "conversation_commit", conversationId: conversation.id, epoch: conversation.epoch, utteranceId, requestId, text });
      },
      receipts(requestId: string): any[] {
        return frames("conversation_work").filter((f) => f.requestId === requestId);
      },
      last(requestId: string): any {
        return frames("conversation_work").filter((f) => f.requestId === requestId).at(-1);
      },
    };
  }
  return { host, live, turns, connect };
}

describe("semantic commit is the only admission", () => {
  test("recognized input and a native request run nothing until the client commits", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Draft the night-watch rota for the palace");
    conversation.session.emit({ kind: "work_requested", handle: "native-1", utteranceId: "u1" });
    await settle();
    expect(s.turns).toHaveLength(0);

    client.commit(conversation, "u1", "r1", "Draft the night-watch rota for the palace");
    await until(() => s.turns.length === 1);
    const req = s.turns[0]!.req;
    expect(req.prompt).toBe("Draft the night-watch rota for the palace");
    // Live modality uses ordinary task policy, including the screen surface.
    expect(req.posture).toBeUndefined();
    expect(req.enforceAllowedTools).toBeUndefined();
    expect(req.noGrantSurface).toBeUndefined();

    s.turns[0]!.answer("The rota names Eumaeus for the first watch.");
    await until(() => conversation.session.returned.length === 1);
    expect(conversation.session.returned[0]).toEqual({
      ref: {
        conversationId: conversation.id,
        epoch: 1,
        utteranceId: "u1",
        turnId: client.last("r1").turnId,
        requestId: "r1",
        nativeHandle: "native-1",
      },
      result: { outcome: "completed", facts: "The rota names Eumaeus for the first watch.", delivery: "when-idle" },
    });
    expect(client.last("r1").turnId).toEqual(expect.any(String));
    await until(() => client.last("r1").delivery === "returned");
    expect(client.last("r1")).toMatchObject({
      state: "completed",
      sessionId: "sess-ithaca-1",
      recognized: "Draft the night-watch rota for the palace",
      submitted: "Draft the night-watch rota for the palace",
    });
  });

  test("an utterance heard only as the assistant's own voice cannot be committed", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u-echo", "no, stop", "assistant");
    client.commit(conversation, "u-echo", "r-echo", "no, stop");
    await until(() => client.receipts("r-echo").length > 0);
    expect(client.last("r-echo")).toMatchObject({ state: "refused", delivery: "discarded" });
    await settle();
    expect(s.turns).toHaveLength(0);
  });

  test("a commit for an utterance the epoch never received is refused", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    client.commit(conversation, "u-unheard", "r-unheard", "Sail for Pylos");
    await until(() => client.receipts("r-unheard").length > 0);
    expect(client.last("r-unheard").state).toBe("refused");
    await settle();
    expect(s.turns).toHaveLength(0);
  });
});

describe("pending work and continued input", () => {
  test("input keeps arriving while work is pending; the next request waits for its own turn in the same session", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "List the suitors still in the hall");
    client.commit(conversation, "u1", "r1", "List the suitors still in the hall");
    await until(() => s.turns.length === 1);

    // Still pending: capture, recognition and a second commit are all accepted.
    await client.speak(conversation, "u2", "And note who brought gifts");
    client.commit(conversation, "u2", "r2", "And note who brought gifts");
    await until(() => client.receipts("r2").length > 0);
    expect(client.last("r2").state).toBe("queued");
    await settle();
    expect(s.turns).toHaveLength(1);

    s.turns[0]!.answer("Antinous and Eurymachus.");
    await until(() => s.turns.length === 2);
    // Same chat session, a distinct turn, never a parallel one.
    expect(s.turns[1]!.req.sessionId).toBe("sess-ithaca-1");
    expect(s.turns[1]!.req.prompt).toBe("And note who brought gifts");
    expect(client.last("r1").turnId).not.toBe(client.last("r2").turnId);
    s.turns[1]!.answer("Eurymachus brought a gold necklace.");
    await until(() => conversation.session.returned.length === 2);
    expect(conversation.session.returned.map(({ ref, result }) => [ref.requestId, ref.utteranceId, result.facts])).toEqual([
      ["r1", "u1", "Antinous and Eurymachus."],
      ["r2", "u2", "Eurymachus brought a gold necklace."],
    ]);
  });

  test("commits made before the first turn names its session still run one at a time in one session", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Who is at the gate?");
    await client.speak(conversation, "u2", "Is it the beggar again?");
    // Back to back: the second commit lands before any session exists.
    client.commit(conversation, "u1", "r1", "Who is at the gate?");
    client.commit(conversation, "u2", "r2", "Is it the beggar again?");
    await until(() => s.turns.length >= 1);
    await settle();
    expect(s.turns.map((turn) => turn.req.prompt)).toEqual(["Who is at the gate?"]);
    s.turns[0]!.answer("A beggar.");
    await until(() => s.turns.length === 2);
    expect(s.turns[1]!.req.sessionId).toBe("sess-ithaca-1");
  });

  test("a full conversation queue refuses visibly instead of dropping", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    for (let i = 1; i <= 5; i++) {
      await client.speak(conversation, `u${i}`, `Count the oxen in pen ${i}`);
      client.commit(conversation, `u${i}`, `r${i}`, `Count the oxen in pen ${i}`);
      await until(() => client.receipts(`r${i}`).length > 0);
    }
    expect(["r1", "r2", "r3", "r4"].map((id) => client.receipts(id)[0].state)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(client.last("r5")).toMatchObject({ state: "refused", delivery: "discarded" });
  });

  test("a repeated request id replays its receipt and never runs twice", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Weigh the grain for the feast");
    client.commit(conversation, "u1", "r1", "Weigh the grain for the feast");
    await until(() => s.turns.length === 1);
    client.commit(conversation, "u1", "r1", "Weigh the grain for the feast");
    await until(() => client.receipts("r1").length >= 3);
    await settle();
    expect(s.turns).toHaveLength(1);
  });
});

describe("no stale result is published", () => {
  test("a result arriving after the user cancelled the turn is discarded", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Summarize the loom's progress");
    client.commit(conversation, "u1", "r1", "Summarize the loom's progress");
    await until(() => s.turns.length === 1);
    expect(s.turns[0]!.req.signal.aborted).toBe(false);

    client.send({ type: "cancel", sessionId: "sess-ithaca-1" });
    await until(() => s.turns[0]!.req.signal.aborted);
    s.turns[0]!.answer("The shroud is half woven.");
    await until(() => client.last("r1").state !== "running");
    await settle();
    expect(client.last("r1")).toMatchObject({ state: "cancelled", delivery: "discarded" });
    expect(conversation.session.returned).toEqual([]);
  });

  test("a result for a request the provider withdrew is discarded", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Find the bow");
    client.commit(conversation, "u1", "r1", "Find the bow");
    conversation.session.emit({ kind: "work_requested", handle: "native-1", utteranceId: "u1" });
    await until(() => s.turns.length === 1);
    conversation.session.emit({ kind: "work_withdrawn", handle: "native-1", reason: "interrupted" });
    await settle();

    s.turns[0]!.answer("The bow hangs in the storeroom.");
    await until(() => client.last("r1").state === "completed");
    await settle();
    expect(conversation.session.returned).toEqual([]);
    // The host outcome survives the discarded narration.
    expect(client.last("r1")).toMatchObject({ state: "completed", delivery: "discarded" });
  });

  test("a result for a replaced epoch reaches neither session; the new epoch is resynchronized, not resubmitted", async () => {
    const s = setup();
    const client = await s.connect();
    const first = await client.open();
    await client.speak(first, "u1", "Ask Mentor about the ship");
    client.commit(first, "u1", "r1", "Ask Mentor about the ship");
    first.session.emit({ kind: "work_requested", handle: "native-1" });
    await until(() => s.turns.length === 1);

    const second = await client.open({ conversationId: first.id });
    expect(second.id).toBe(first.id);
    expect(second.epoch).toBe(2);
    expect(client.frames("conversation_closed")).toEqual([
      { type: "conversation_closed", conversationId: first.id, epoch: 1, reason: "replaced" },
    ]);
    expect(first.session.closed).toBe(true);
    expect(second.session.options.resync.work.map((w) => [w.requestId, w.state])).toEqual([["r1", "running"]]);
    expect(second.opened.resync).toEqual({ work: 1, outputs: 0 });
    expect(client.sinceOpened("conversation_work").map((w) => [w.requestId, w.epoch, w.state])).toEqual([["r1", 1, "running"]]);

    s.turns[0]!.answer("Mentor has a ship ready at dawn.");
    await until(() => client.last("r1").state === "completed");
    await settle();
    expect(first.session.returned).toEqual([]);
    expect(second.session.returned).toEqual([]);
    expect(client.last("r1").delivery).toBe("discarded");
    expect(s.turns).toHaveLength(1);
  });

  test("audio and commits still in flight for an ended epoch are never applied to the new one", async () => {
    const s = setup();
    const client = await s.connect();
    const first = await client.open();
    await client.speak(first, "u1", "Ready the boat");
    const second = await client.open({ conversationId: first.id });
    client.send({ type: "conversation_audio", conversationId: first.id, epoch: 1, utteranceId: "u9", sequence: 50, rate: 16_000, pcm: SILENCE });
    client.commit(first, "u1", "r-stale", "Ready the boat");
    await until(() => client.receipts("r-stale").length > 0);
    expect(client.last("r-stale").state).toBe("refused");
    await settle();
    expect(second.session.audio).toEqual([]);
    expect(s.turns).toHaveLength(0);
  });

  test("stopping the conversation cancels unsubmitted work; submitted work finishes undelivered", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Bar the gates");
    client.commit(conversation, "u1", "r1", "Bar the gates");
    await until(() => s.turns.length === 1);
    await client.speak(conversation, "u2", "Then light the lamps");
    client.commit(conversation, "u2", "r2", "Then light the lamps");
    await until(() => client.receipts("r2").length > 0);

    client.send({ type: "conversation_stop", conversationId: conversation.id });
    await until(() => client.last("r2").state === "cancelled");
    expect(client.frames("conversation_closed").at(-1)).toMatchObject({ reason: "stopped" });
    s.turns[0]!.answer("The gates are barred.");
    // The submitted turn finishes as an ordinary chat turn.
    await until(() => client.frames("result").length === 1);
    await settle();
    expect(s.turns).toHaveLength(1);
    expect(conversation.session.returned).toEqual([]);
    // A stopped conversation has no client to receipt; the chat transcript holds the outcome.
    expect(client.last("r1").state).toBe("running");
  });
});

describe("every exit settles, and nothing outgrows its bound", () => {
  test("a host timeout keeps its outcome and is never narrated", async () => {
    const s = setup({ turnTimeoutMs: 60 });
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Tally the stores of wine");
    client.commit(conversation, "u1", "r1", "Tally the stores of wine");
    await until(() => s.turns.length === 1);
    await until(() => s.turns[0]!.req.signal.aborted);
    s.turns[0]!.answer("Forty jars.");
    await until(() => client.last("r1").state !== "running");
    await settle();
    expect(conversation.session.returned).toEqual([]);
    expect(client.last("r1")).toMatchObject({ state: "cancelled", delivery: "discarded", reason: "Turn timed out" });
  });

  test("work queued behind a start whose routing fails settles, and the conversation keeps going", async () => {
    let stall = true;
    let failRouting: ((err: Error) => void) | null = null;
    const s = setup({
      listProfiles: () => stall
        ? new Promise((_, reject) => { stall = false; failRouting = reject; })
        : Promise.resolve([{ id: "fake", label: "FAKE" }]),
    });
    const client = await s.connect();
    const conversation = await client.open({ sessionId: "sess-dock" });
    // An ordinary message starts routing the same session and stalls there.
    client.send({ type: "chat_message", text: "Is the ship at the dock?", sessionId: "sess-dock" });
    await until(() => failRouting !== null);
    await client.speak(conversation, "u1", "And who is aboard?");
    client.commit(conversation, "u1", "r1", "And who is aboard?");
    await until(() => client.receipts("r1").length > 0);
    expect(client.last("r1").state).toBe("queued");
    failRouting!(new Error("Routing failed for the fixture"));
    await until(() => client.frames("error").length > 0);
    await settle();
    expect(client.last("r1")).toMatchObject({ state: "error", delivery: "discarded" });

    await client.speak(conversation, "u2", "Then check the oars");
    client.commit(conversation, "u2", "r2", "Then check the oars");
    await until(() => s.turns.length === 1);
    expect(s.turns[0]!.req.prompt).toBe("Then check the oars");
  });

  test("playback evidence for an ended epoch never lands on the next epoch's output", async () => {
    const s = setup();
    const client = await s.connect();
    const first = await client.open();
    first.session.emit({ kind: "output_transcript", outputId: "o1", sequence: 0, text: "The first answer." });
    await until(() => client.frames("conversation_event").length === 1);
    const second = await client.open({ conversationId: first.id });
    second.session.emit({ kind: "output_transcript", outputId: "o1", sequence: 0, text: "The second answer." });
    await until(() => client.frames("conversation_event").length === 2);
    client.send({ type: "conversation_playback", conversationId: first.id, epoch: 1, outputId: "o1", playback: "played", playedSamples: { start: 0, end: 4800 } });
    await settle();
    const third = await client.open({ conversationId: first.id });
    expect(third.opened.resync).toEqual({ work: 0, outputs: 2 });
    expect(client.sinceOpened("conversation_output")).toEqual([
      { type: "conversation_output", conversationId: first.id, epoch: 1, outputId: "o1", generated: "The first answer.", playback: "unknown" },
      { type: "conversation_output", conversationId: first.id, epoch: 2, outputId: "o1", generated: "The second answer.", playback: "unknown" },
    ]);
  });

  test("results a provider never acknowledges cannot grow the receipts past their bound", async () => {
    const s = setup({ holdReturns: true });
    const client = await s.connect();
    const conversation = await client.open();
    for (let i = 0; i < 64; i++) {
      await client.speak(conversation, `u${i}`, `Count jar ${i}`);
      client.commit(conversation, `u${i}`, `r${i}`, `Count jar ${i}`);
      await until(() => s.turns.length === i + 1);
      s.turns[i]!.answer(`Jar ${i} is full.`);
      await until(() => client.last(`r${i}`).state === "completed");
    }
    expect(conversation.session.returned).toHaveLength(64);
    await client.speak(conversation, "u-over", "Count one more");
    client.commit(conversation, "u-over", "r-over", "Count one more");
    await until(() => client.receipts("r-over").length > 0);
    expect(client.last("r-over")).toMatchObject({ state: "refused", delivery: "discarded" });
    await settle();
    expect(s.turns).toHaveLength(64);
  }, 20_000);
});

describe("second review pass: identity, resync and retry", () => {
  test("a result the provider never acknowledged is discarded when its epoch ends, and stops counting against the bound", async () => {
    const s = setup({ holdReturns: true });
    const client = await s.connect();
    const first = await client.open();
    await client.speak(first, "u1", "Seal the storeroom");
    client.commit(first, "u1", "r1", "Seal the storeroom");
    await until(() => s.turns.length === 1);
    s.turns[0]!.answer("Sealed.");
    await until(() => first.session.returned.length === 1);
    expect(client.last("r1").delivery).toBe("pending");
    await client.open({ conversationId: first.id });
    expect(client.sinceOpened("conversation_work").map((w) => [w.requestId, w.delivery])).toEqual([["r1", "discarded"]]);
  });

  test("a request id whose receipt was evicted is refused, never run again", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    for (let i = 0; i <= 64; i++) {
      await client.speak(conversation, `u${i}`, `Count jar ${i}`);
      client.commit(conversation, `u${i}`, `r${i}`, `Count jar ${i}`);
      await until(() => s.turns.length === i + 1);
      s.turns[i]!.answer(`Jar ${i} is full.`);
      await until(() => client.last(`r${i}`).delivery === "returned");
    }
    const resumed = await client.open({ conversationId: conversation.id });
    expect(client.sinceOpened("conversation_work").map((receipt) => receipt.requestId)).toEqual(
      Array.from({ length: 64 }, (_, index) => `r${index + 1}`)
    );
    await client.speak(resumed, "u-again", "Count jar 0");
    const before = client.receipts("r0").length;
    client.commit(resumed, "u-again", "r0", "Count jar 0");
    await until(() => client.receipts("r0").length > before);
    expect(client.last("r0")).toMatchObject({ state: "refused", reason: "That request id was already used in this conversation." });
    await settle();
    expect(s.turns).toHaveLength(64 + 1);
  }, 20_000);

  test("every retained receipt is resent whole, one frame each, at the largest recognized size", async () => {
    const s = setup();
    const client = await s.connect();
    const first = await client.open();
    // Multibyte text near every bound: one fragment per utterance is enough
    // to show a receipt is never clipped on the way out.
    const long = "ἀ".repeat(1_900);
    for (let i = 0; i < 12; i++) {
      await client.speak(first, `u${i}`, long);
      client.commit(first, `u${i}`, `r${i}`, "ἀ".repeat(8_000));
      await until(() => s.turns.length === i + 1);
      s.turns[i]!.answer("ok");
      await until(() => client.last(`r${i}`).delivery === "returned");
    }
    await client.open({ conversationId: first.id });
    const resent = client.sinceOpened("conversation_work");
    expect(resent).toHaveLength(12);
    for (const receipt of resent) {
      expect(receipt.recognized).toBe(long);
      expect(receipt.submitted).toBe("ἀ".repeat(8_000));
    }
    const resumed = { id: first.id, epoch: 2, session: s.live.sessions.at(-1)! };
    await client.speak(resumed, "u-over", "One more character");
    client.commit(resumed, "u-over", "r-over", "ἀ".repeat(8_001));
    await settle();
    expect(client.frames("error").at(-1)?.code).toBe("PARSE_ERROR");
    expect(s.turns).toHaveLength(12);
  }, 20_000);

  test("recognized text beyond the per-utterance bound closes the epoch instead of being clipped", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "x".repeat(CONVERSATION_LIMITS.maxFragmentChars));
    for (let sequence = 1; sequence < 9; sequence++) {
      conversation.session.emit({ kind: "input_fragment", utteranceId: "u1", sequence, text: "x".repeat(CONVERSATION_LIMITS.maxFragmentChars), finalization: "interim", certainty: "unknown", origin: "user" });
    }
    await settle();
    expect(client.frames("conversation_closed")[0]).toMatchObject({ reason: "backpressure" });
  });

  test("a failed live turn offers no client Retry, which could not restore its host identity", async () => {
    const db = createUiDb(":memory:");
    const live = fakeLiveProvider();
    const requests: StartTurnRequest[] = [];
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (req) => {
        requests.push(req);
        req.bridge.emit({ type: "session_info", sessionId: "sess-retry", isNew: true });
        req.bridge.emit({ type: "result", sessionId: "sess-retry", outcome: "error", durationMs: 1, numTurns: 0, isError: true,
          failure: { errorClass: "overloaded", message: "The fictional runtime is overloaded." } });
      },
    });
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], "fake"), catalog: createSessionCatalog(() => db), conversationProvider: live.provider });
    cleanup = () => { host.coordinator.reset(); host.close(); db.close(); };
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    const frames = (type: string) => sent.map((x) => JSON.parse(x)).filter((f) => f.type === type);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    await handlers.onOpen(undefined as never, ws);

    // Control: the same failure on a typed turn is retryable.
    send({ type: "chat_message", text: "typed question" });
    await until(() => frames("result").length === 1);
    expect(frames("result")[0].retryOfTurnId).toEqual(expect.any(String));

    send({ type: "conversation_start", sessionId: "sess-retry" });
    await until(() => frames("conversation_opened").length === 1);
    const opened = frames("conversation_opened")[0];
    send({ type: "conversation_audio", conversationId: opened.conversationId, epoch: 1, utteranceId: "u1", sequence: 0, rate: 16_000, pcm: SILENCE });
    await until(() => live.sessions[0]!.audio.length === 1);
    live.sessions[0]!.emit({ kind: "input_fragment", utteranceId: "u1", sequence: 0, text: "spoken question", finalization: "final", certainty: "unknown", origin: "user" });
    await until(() => frames("conversation_event").length === 1);
    send({ type: "conversation_commit", conversationId: opened.conversationId, epoch: 1, utteranceId: "u1", requestId: "r1", text: "spoken question" });
    await until(() => frames("result").length === 2);
    expect(requests[1]!.posture).toBeUndefined();
    expect(frames("result")[1].retryOfTurnId).toBeUndefined();
  });
});

describe("third review pass: failure, metering and teardown", () => {
  test("a turn that ends with only a pre-session error is a failure, not a completion", async () => {
    const db = createUiDb(":memory:");
    const live = fakeLiveProvider();
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (req) => {
        // As a backend that fails before naming a session: an error frame, no result.
        req.bridge.emit({ type: "error", code: "FIXTURE_ERROR", message: "The fictional runtime failed before the session existed." });
      },
    });
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], "fake"), catalog: createSessionCatalog(() => db), conversationProvider: live.provider });
    cleanup = () => { host.coordinator.reset(); host.close(); db.close(); };
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    const frames = (type: string) => sent.map((x) => JSON.parse(x)).filter((f) => f.type === type);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    await handlers.onOpen(undefined as never, ws);
    send({ type: "conversation_start" });
    await until(() => frames("conversation_opened").length === 1);
    const opened = frames("conversation_opened")[0];
    send({ type: "conversation_audio", conversationId: opened.conversationId, epoch: 1, utteranceId: "u1", sequence: 0, rate: 16_000, pcm: SILENCE });
    await until(() => live.sessions[0]!.audio.length === 1);
    live.sessions[0]!.emit({ kind: "input_fragment", utteranceId: "u1", sequence: 0, text: "Where is the raft?", finalization: "final", certainty: "unknown", origin: "user" });
    await until(() => frames("conversation_event").length === 1);
    send({ type: "conversation_commit", conversationId: opened.conversationId, epoch: 1, utteranceId: "u1", requestId: "r1", text: "Where is the raft?" });
    await until(() => frames("conversation_work").some((f) => f.state !== "queued" && f.state !== "running"));
    await settle();
    const last = frames("conversation_work").at(-1);
    expect(last).toMatchObject({ state: "error", reason: "The fictional runtime failed before the session existed." });
    expect(live.sessions[0]!.returned.map(({ result }) => result.outcome)).toEqual(["error"]);
  });

  test("a missing audio chunk closes capture instead of leaving a silent hole", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    const chunk = (sequence: number) => ({ type: "conversation_audio", conversationId: conversation.id, epoch: 1, utteranceId: "u1", sequence, rate: 16_000, pcm: SILENCE });
    client.send(chunk(0));
    client.send(chunk(1));
    // Chunk 2 never arrives (metered away on a congested connection).
    client.send(chunk(3));
    await settle();
    expect(conversation.session.audio.map((a) => a.sequence)).toEqual([0, 1]);
    expect(client.frames("conversation_closed")[0]).toMatchObject({ reason: "correlation" });
  });

  test("host teardown closes every live provider session", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    expect(conversation.session.closed).toBe(false);
    s.host.close();
    await settle();
    expect(conversation.session.closed).toBe(true);
    expect(conversation.session.options.signal.aborted).toBe(true);
  });
});

describe("fourth review pass: identities outlive retention", () => {
  test("sixteen uncommitted utterances fit; a seventeenth closes capture", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    for (let index = 0; index < 16; index++) {
      await client.speak(conversation, `u${index}`, `Count fold ${index}`);
    }
    expect(conversation.session.audio).toHaveLength(16);
    expect(client.frames("conversation_closed")).toEqual([]);
    client.send({ type: "conversation_audio", conversationId: conversation.id, epoch: 1,
      utteranceId: "u-over", sequence: 16, rate: 16_000, pcm: SILENCE });
    await settle();
    expect(client.frames("conversation_closed")).toEqual([
      expect.objectContaining({ reason: "backpressure" }),
    ]);
    expect(conversation.session.audio).toHaveLength(16);
  });

  test("an evicted committed utterance cannot come back as new input and run again", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    for (let i = 0; i <= 16; i++) {
      await client.speak(conversation, `u${i}`, `Count the goats in fold ${i}`);
      client.commit(conversation, `u${i}`, `r${i}`, `Count the goats in fold ${i}`);
      await until(() => s.turns.length === i + 1);
      s.turns[i]!.answer(`Fold ${i} counted.`);
      await until(() => client.last(`r${i}`).state === "completed");
    }
    // u0's fragments were evicted to make room; its identity was not.
    client.send({ type: "conversation_audio", conversationId: conversation.id, epoch: 1, utteranceId: "u0", sequence: 16 + 1, rate: 16_000, pcm: SILENCE });
    await settle();
    expect(client.frames("conversation_closed")[0]).toMatchObject({ reason: "correlation" });
    expect(s.turns).toHaveLength(16 + 1);
  }, 20_000);

  test("a native request naming an utterance whose result already went out receives that result with its handle", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "When does the ship sail?");
    client.commit(conversation, "u1", "r1", "When does the ship sail?");
    await until(() => s.turns.length === 1);
    s.turns[0]!.answer("At dawn.");
    await until(() => client.last("r1").delivery === "returned");
    expect(conversation.session.returned.map(({ ref }) => ref.nativeHandle)).toEqual([undefined]);

    conversation.session.emit({ kind: "work_requested", handle: "native-late", utteranceId: "u1" });
    await settle();
    expect(conversation.session.returned[1]).toEqual({
      ref: { ...conversation.session.returned[0]!.ref, nativeHandle: "native-late" },
      result: { outcome: "completed", facts: "At dawn.", delivery: "when-idle" },
    });
  });

  test("a native request naming no utterance never binds to finished work", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Is the well full?");
    client.commit(conversation, "u1", "r1", "Is the well full?");
    await until(() => s.turns.length === 1);
    s.turns[0]!.answer("It is.");
    await until(() => client.last("r1").delivery === "returned");
    conversation.session.emit({ kind: "work_requested", handle: "native-next" });
    await settle();
    expect(conversation.session.returned).toHaveLength(1);
    // An unkeyed advisory never borrows the next commit either.
    await client.speak(conversation, "u2", "And the cistern?");
    client.commit(conversation, "u2", "r2", "And the cistern?");
    await until(() => s.turns.length === 2);
    s.turns[1]!.answer("Half full.");
    await until(() => conversation.session.returned.length === 2);
    expect(conversation.session.returned[1]!.ref).toMatchObject({ requestId: "r2" });
    expect(conversation.session.returned[1]!.ref.nativeHandle).toBeUndefined();
  });
});

describe("fifth review pass: cancellation and follow-up boundaries", () => {
  test("cancelling the session also cancels the conversation's committed backlog", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Burn the old nets");
    client.commit(conversation, "u1", "r1", "Burn the old nets");
    await until(() => s.turns.length === 1);
    await client.speak(conversation, "u2", "Then mend the new ones");
    client.commit(conversation, "u2", "r2", "Then mend the new ones");
    await until(() => client.receipts("r2").length > 0);

    client.send({ type: "cancel", sessionId: "sess-ithaca-1" });
    await until(() => s.turns[0]!.req.signal.aborted);
    s.turns[0]!.answer("Too late.");
    await settle();
    expect(client.last("r2")).toMatchObject({ state: "cancelled", reason: "Cancelled by user" });
    expect(s.turns).toHaveLength(1);
  });

  test("a typed message during a voice turn queues as its own turn instead of joining it", async () => {
    const db = createUiDb(":memory:");
    const live = fakeLiveProvider();
    const followUps: string[] = [];
    const turns: Array<{ req: StartTurnRequest; answer: (text: string) => void }> = [];
    const backend = makeFakeBackend({
      id: "fake",
      capabilities: { followUp: true },
      followUp: async (req) => { followUps.push(req.prompt); },
      startTurn: async (req) => {
        req.bridge.emit({ type: "session_info", sessionId: "sess-hall", isNew: req.sessionId === undefined });
        const text = await new Promise<string>((resolve) => turns.push({ req, answer: resolve }));
        req.bridge.emit({ type: "text_delta", text });
        req.bridge.emit({ type: "result", sessionId: "sess-hall", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
      },
    });
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], "fake"), catalog: createSessionCatalog(() => db), conversationProvider: live.provider });
    cleanup = () => { for (const t of turns) t.answer(""); host.coordinator.reset(); host.close(); db.close(); };
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    const frames = (type: string) => sent.map((x) => JSON.parse(x)).filter((f) => f.type === type);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    await handlers.onOpen(undefined as never, ws);
    send({ type: "conversation_start" });
    await until(() => frames("conversation_opened").length === 1);
    const opened = frames("conversation_opened")[0];
    send({ type: "conversation_audio", conversationId: opened.conversationId, epoch: 1, utteranceId: "u1", sequence: 0, rate: 16_000, pcm: SILENCE });
    await until(() => live.sessions[0]!.audio.length === 1);
    live.sessions[0]!.emit({ kind: "input_fragment", utteranceId: "u1", sequence: 0, text: "Who keeps the keys?", finalization: "final", certainty: "unknown", origin: "user" });
    await until(() => frames("conversation_event").length === 1);
    send({ type: "conversation_commit", conversationId: opened.conversationId, epoch: 1, utteranceId: "u1", requestId: "r1", text: "Who keeps the keys?" });
    await until(() => turns.length === 1);

    send({ type: "chat_message", text: "typed aside", sessionId: "sess-hall" });
    await settle();
    expect(followUps).toEqual([]);
    turns[0]!.answer("Eurycleia keeps them.");
    await until(() => turns.length === 2);
    expect(turns[1]!.req.prompt).toBe("typed aside");
    expect(turns[1]!.req.posture).toBeUndefined();
    await until(() => live.sessions[0]!.returned.length === 1);
    expect(live.sessions[0]!.returned[0]!.result.facts).toBe("Eurycleia keeps them.");
  });
});

describe("sixth review pass: cancellation without a session id, metering", () => {
  test("a host-wide cancel (shutdown) cancels the conversation backlog too", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Lower the sail");
    client.commit(conversation, "u1", "r1", "Lower the sail");
    await until(() => s.turns.length === 1);
    await client.speak(conversation, "u2", "Then row for the harbour");
    client.commit(conversation, "u2", "r2", "Then row for the harbour");
    await until(() => client.receipts("r2").length > 0);

    s.host.coordinator.cancelAll("Server shutting down");
    s.turns[0]!.answer("Lowered.");
    await settle();
    expect(client.last("r2")).toMatchObject({ state: "cancelled", reason: "The request before it was cancelled." });
    expect(s.turns).toHaveLength(1);
  });

  test("a frame metered away by the connection's rate limit ends capture visibly", async () => {
    const s = setup({ wsRate: { ratePerSecond: 1, burst: 4 } });
    const client = await s.connect();
    const conversation = await client.open();
    for (let sequence = 0; sequence < 6; sequence++) {
      client.send({ type: "conversation_audio", conversationId: conversation.id, epoch: 1, utteranceId: "u1", sequence, rate: 16_000, pcm: SILENCE });
    }
    await settle();
    expect(client.frames("error").some((f) => f.code === "RATE_LIMITED")).toBe(true);
    expect(client.frames("conversation_closed")[0]).toMatchObject({ reason: "backpressure" });
  });
});

describe("seventh review pass: extra native requests and shutdown during routing", () => {
  test("further native requests for an utterance that already holds a handle are dropped, never parked", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    await client.speak(conversation, "u1", "Who mends the sails?");
    conversation.session.emit({ kind: "work_requested", handle: "native-1", utteranceId: "u1" });
    conversation.session.emit({ kind: "work_requested", handle: "native-2", utteranceId: "u1" });
    await settle();
    client.commit(conversation, "u1", "r1", "Who mends the sails?");
    await until(() => s.turns.length === 1);
    for (let i = 3; i < 3 + CONVERSATION_LIMITS.maxPendingNativeRequests + 1; i++) {
      conversation.session.emit({ kind: "work_requested", handle: `native-${i}`, utteranceId: "u1" });
    }
    await settle();
    expect(client.frames("conversation_closed")).toEqual([]);
    s.turns[0]!.answer("Mentor's crew.");
    await until(() => conversation.session.returned.length === 1);
    expect(conversation.session.returned[0]!.ref.nativeHandle).toBe("native-1");
  });

  test("a host-wide cancel releases conversation work queued behind a session start still routing", async () => {
    let stall = true;
    let releaseRouting: (() => void) | null = null;
    const s = setup({
      listProfiles: () => stall
        ? new Promise((resolve) => { stall = false; releaseRouting = () => resolve([{ id: "fake", label: "FAKE" }]); })
        : Promise.resolve([{ id: "fake", label: "FAKE" }]),
    });
    const client = await s.connect();
    const conversation = await client.open({ sessionId: "sess-quay" });
    client.send({ type: "chat_message", text: "Is the quay clear?", sessionId: "sess-quay" });
    await until(() => releaseRouting !== null);
    await client.speak(conversation, "u1", "Then load the amphorae");
    client.commit(conversation, "u1", "r1", "Then load the amphorae");
    await until(() => client.receipts("r1").length > 0);
    expect(client.last("r1").state).toBe("queued");

    s.host.coordinator.cancelAll("Server shutting down");
    await settle();
    expect(client.last("r1")).toMatchObject({ state: "cancelled" });
    releaseRouting!();
  });
});

describe("correlation across conversations and scopes", () => {
  test("two conversations in two sessions each receive only their own result", async () => {
    const s = setup();
    const penelope = await s.connect();
    const telemachus = await s.connect();
    const a = await penelope.open();
    const b = await telemachus.open();
    await penelope.speak(a, "u-a", "How many days since the ship left?");
    await telemachus.speak(b, "u-b", "Who guards the herd?");
    penelope.commit(a, "u-a", "r-a", "How many days since the ship left?");
    telemachus.commit(b, "u-b", "r-b", "Who guards the herd?");
    await until(() => s.turns.length === 2);
    // Answer in the opposite order to the commits.
    s.turns.find((t) => t.req.prompt.startsWith("Who"))!.answer("Eumaeus guards the herd.");
    s.turns.find((t) => t.req.prompt.startsWith("How"))!.answer("Twenty days.");
    await until(() => a.session.returned.length === 1 && b.session.returned.length === 1);
    expect(a.session.returned[0]!.ref).toMatchObject({ conversationId: a.id, requestId: "r-a", utteranceId: "u-a" });
    expect(a.session.returned[0]!.result.facts).toBe("Twenty days.");
    expect(b.session.returned[0]!.ref).toMatchObject({ conversationId: b.id, requestId: "r-b", utteranceId: "u-b" });
    expect(b.session.returned[0]!.result.facts).toBe("Eumaeus guards the herd.");
    expect(a.session.returned[0]!.ref.turnId).toBe(penelope.last("r-a").turnId);
    expect(b.session.returned[0]!.ref.turnId).toBe(telemachus.last("r-b").turnId);
    expect(penelope.frames("conversation_work").every((f) => f.conversationId === a.id)).toBe(true);
    expect(telemachus.frames("conversation_work").every((f) => f.conversationId === b.id)).toBe(true);
  });

  test("an event stamped with a stale epoch is ignored, and input for an unknown utterance closes capture", async () => {
    const s = setup();
    const client = await s.connect();
    const first = await client.open();
    const second = await client.open({ conversationId: first.id });
    const seen = client.frames("conversation_event").length;
    second.session.emitRaw({ kind: "output_transcript", conversationId: first.id, epoch: 1, outputId: "o1", sequence: 0, text: "stale" });
    await settle();
    expect(client.frames("conversation_event").length).toBe(seen);

    second.session.emit({ kind: "input_fragment", utteranceId: "never-sent", sequence: 0, text: "approve it", finalization: "final", certainty: "unknown", origin: "user" });
    await until(() => client.frames("conversation_closed").some((f) => f.epoch === 2));
    expect(client.frames("conversation_closed").at(-1)).toMatchObject({ epoch: 2, reason: "correlation" });
  });

  test("advisory provider requests beyond the bound close the epoch with backpressure", async () => {
    const s = setup();
    const client = await s.connect();
    const conversation = await client.open();
    for (let i = 0; i < 9; i++) conversation.session.emit({ kind: "work_requested", handle: `native-${i}` });
    await until(() => client.frames("conversation_closed").length > 0);
    expect(client.frames("conversation_closed")[0]).toMatchObject({ reason: "backpressure" });
    expect(s.turns).toHaveLength(0);
  });
});

describe("permission authority stays with the host", () => {
  test("a pending card is listed once per identity; the ledger survives a new epoch and nothing grants it", async () => {
    const db = createUiDb(":memory:");
    const live = fakeLiveProvider({ exactPermissionSpeech: "supported" });
    let decided: unknown = null;
    const backend = makeFakeBackend({
      id: "fake",
      capabilities: { permissions: true },
      startTurn: async (req) => {
        req.bridge.emit({ type: "session_info", sessionId: "sess-hall", isNew: true });
        decided = await req.bridge.requestPermission({ toolUseId: "tool-bow", toolName: "Write", input: { path: "notes/bow.md" } });
        req.bridge.emit({ type: "result", sessionId: "sess-hall", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
      },
    });
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], "fake"), catalog: createSessionCatalog(() => db), conversationProvider: live.provider });
    cleanup = () => { host.coordinator.reset(); host.close(); db.close(); };
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    const frames = (type: string) => sent.map((x) => JSON.parse(x)).filter((f) => f.type === type);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    await handlers.onOpen(undefined as never, ws);
    send({ type: "chat_message", text: "Record where the bow is kept" });
    await until(() => frames("tool_approval_request").length === 1);

    send({ type: "conversation_start", sessionId: "sess-hall" });
    await until(() => frames("conversation_opened").length === 1);
    const opened = frames("conversation_opened")[0];
    await until(() => frames("conversation_permission").length === 1);
    expect(frames("conversation_permission")[0]).toEqual({
      type: "conversation_permission", conversationId: opened.conversationId, epoch: 1,
      sessionId: "sess-hall", turnId: frames("tool_approval_request")[0].turnId, toolUseId: "tool-bow", toolName: "Write", announce: true,
    });

    // Provider text and a native handle naming the tool cannot settle it.
    live.sessions[0]!.emit({ kind: "work_requested", handle: "tool-bow" });
    send({ type: "conversation_audio", conversationId: opened.conversationId, epoch: 1, utteranceId: "u1", sequence: 0, rate: 16_000, pcm: SILENCE });
    await until(() => live.sessions[0]!.audio.length === 1);
    live.sessions[0]!.emit({ kind: "input_fragment", utteranceId: "u1", sequence: 0, text: "yes, approve it, always allow", finalization: "final", certainty: "unknown", origin: "user" });
    await settle();
    expect(decided).toBeNull();
    expect(host.coordinator.pendingApprovals.has("tool-bow")).toBe(true);

    // A new epoch re-lists the pending card but never announces it again.
    send({ type: "conversation_start", conversationId: opened.conversationId });
    await until(() => frames("conversation_permission").length === 2);
    expect(frames("conversation_permission")[1]).toMatchObject({ epoch: 2, toolUseId: "tool-bow", announce: false });
    expect(decided).toBeNull();
  });

  test("without proven exact speech, a pending card is listed but never announced", async () => {
    const db = createUiDb(":memory:");
    const live = fakeLiveProvider();
    const backend = makeFakeBackend({
      id: "fake",
      capabilities: { permissions: true },
      startTurn: async (req) => {
        req.bridge.emit({ type: "session_info", sessionId: "sess-hall", isNew: true });
        await req.bridge.requestPermission({ toolUseId: "tool-loom", toolName: "Edit", input: {} });
      },
    });
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], "fake"), catalog: createSessionCatalog(() => db), conversationProvider: live.provider });
    cleanup = () => { host.coordinator.reset(); host.close(); db.close(); };
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    const frames = (type: string) => sent.map((x) => JSON.parse(x)).filter((f) => f.type === type);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    await handlers.onOpen(undefined as never, ws);
    send({ type: "conversation_start", sessionId: "sess-hall" });
    await until(() => frames("conversation_opened").length === 1);
    send({ type: "chat_message", text: "Note the loom's pattern", sessionId: "sess-hall" });
    await until(() => frames("conversation_permission").length === 1);
    expect(frames("conversation_permission")[0]).toMatchObject({ toolUseId: "tool-loom", announce: false });
  });
});

describe("negotiation keeps legacy clients unchanged", () => {
  test("only a host with a provider advertises liveConversation; without one every conversation frame is refused", async () => {
    const withProvider = setup();
    const a = await withProvider.connect();
    expect(a.frames("server_hello")[0].capabilities).toMatchObject({ liveConversation: true, toolResolution: true });
    cleanup?.();

    const without = setup({ conversation: false });
    const b = await without.connect();
    expect(b.frames("server_hello")[0].capabilities.liveConversation).toBeUndefined();
    b.send({ type: "conversation_start" });
    await until(() => b.frames("error").length > 0);
    expect(b.frames("error")[0]).toMatchObject({ code: "CONVERSATION_UNAVAILABLE" });
    // An ordinary chat turn keeps its own posture.
    b.send({ type: "chat_message", text: "Plain typed question" });
    await until(() => without.turns.length === 1);
    expect(without.turns[0]!.req.noGrantSurface).toBeUndefined();
    expect(without.turns[0]!.req.posture).toBeUndefined();
    expect(without.turns[0]!.req.enforceAllowedTools).toBeUndefined();
  });

  test("a disconnect ends capture without a frame; resuming opens the next epoch", async () => {
    const s = setup();
    const first = await s.connect();
    const conversation = await first.open();
    first.close();
    await until(() => conversation.session.closed);
    const second = await s.connect();
    const resumed = await second.open({ conversationId: conversation.id });
    expect(resumed).toMatchObject({ id: conversation.id, epoch: 2 });
    expect(first.frames("conversation_closed")).toEqual([]);
  });
});

test("a resumable pause closes capture but retains the conversation for an explicit new epoch", async () => {
  const s = setup();
  const client = await s.connect();
  const conversation = await client.open();
  await client.speak(conversation, "u-pause", "Find the departure note");
  client.commit(conversation, "u-pause", "r-pause", "Find the departure note");
  await until(() => s.turns.length === 1);
  client.send({ type: "conversation_stop", conversationId: conversation.id, resumable: true });
  await until(() => client.frames("conversation_closed").length === 1);
  client.send({ type: "conversation_start", conversationId: conversation.id });
  await settle();
  expect(client.frames("conversation_opened"), "pause retains the identity instead of reporting CONVERSATION_UNKNOWN").toHaveLength(2);
  expect(client.frames("conversation_opened").at(-1)).toMatchObject({ conversationId: conversation.id, epoch: 2, resync: { work: 1, outputs: 0 } });
  expect(s.turns).toHaveLength(1);
  s.turns[0]!.answer("The note is at the palace.");
  await until(() => client.last("r-pause").state === "completed");
  expect(client.last("r-pause").delivery).toBe("discarded");
  expect(s.live.sessions[1]!.returned).toHaveLength(0);
});

test("a new voice conversation uses its independently selected agent profile", async () => {
  const s = setup({ listProfiles: async () => [{ id: "palace-default", label: "Palace default" }, { id: "palace-model", label: "Palace model" }] });
  const client = await s.connect();
  const conversation = await client.open({ agentProviderId: "palace-model" });
  await client.speak(conversation, "u-profile", "Find the departure note");
  client.commit(conversation, "u-profile", "r-profile", "Find the departure note");
  await until(() => s.turns.length === 1);
  expect(s.turns[0]!.req.profileId, "the disclosed selected profile is the one given to the agent backend").toBe("palace-model");
});

for (const kind of ["list", "rank", "form"] as const) test(`live work preserves the ${kind} card's independent host response`, async () => {
  const s = setup();
  const client = await s.connect();
  const conversation = await client.open();
  await client.speak(conversation, "u-card", "Review the voyage supplies");
  client.commit(conversation, "u-card", "r-card", "Review the voyage supplies");
  await until(() => s.turns.length === 1);
  const bridge = s.turns[0]!.req.bridge;
  expect(s.turns[0]!.req.noGrantSurface).toBeUndefined();
  const requestId = `ithaca-${kind}`;
  const pending = kind === "list" ? bridge.askUserList!(requestId, { prompt: "Review the supplies", scale: [{ label: "Ready" }, { label: "Missing" }], items: [{ id: "rope", label: "Rope" }], allowSkip: false, notes: false })
    : kind === "rank" ? bridge.askUserRank!(requestId, { prompt: "Order the supplies", items: [{ id: "rope", label: "Rope" }, { id: "timber", label: "Timber" }] })
    : bridge.askUserForm!(requestId, { prompt: "Plan the departure", nodes: [{ kind: "text", id: "day", prompt: "Which day?" }] });
  await until(() => client.frames(`ask_user_${kind}_request`).length === 1);
  const frame = client.frames(`ask_user_${kind}_request`)[0]!;
  const payload = kind === "list" ? { answers: { rope: "Ready" } } : kind === "rank" ? { order: ["timber", "rope"], unchanged: false } : { answers: { day: "Tomorrow" } };
  client.send({ type: `ask_user_${kind}_response`, requestId, submissionId: `ithaca-${kind}-answer`, turnId: frame.turnId, ...payload });
  expect(await pending).toMatchObject(payload);
  expect(s.turns).toHaveLength(1);
});

test("opening correlation is echoed so an abandoned client's late opening can be retired", async () => {
  const s = setup();
  const client = await s.connect();
  const conversation = await client.open({ requestId: "ithaca-opening" });
  expect(conversation.opened.requestId).toBe("ithaca-opening");
  client.send({ type: "conversation_stop", conversationId: conversation.id, resumable: true });
  await until(() => client.frames("conversation_closed").length === 1);
  const resumed = await client.open({ conversationId: conversation.id, requestId: "ithaca-resume" });
  expect(resumed.opened).toMatchObject({ requestId: "ithaca-resume", epoch: 2 });
});

test("a live screen denial publishes one host outcome; backend denial events cannot replace it", async () => {
  const s = setup({ authorized: true });
  const client = await s.connect();
  client.send({ type: "client_hello", protocolRev: 5, capabilities: { toolResolution: true } });
  const conversation = await client.open();
  await client.speak(conversation, "u-denied", "Update the raft plan");
  client.commit(conversation, "u-denied", "r-denied", "Update the raft plan");
  await until(() => s.turns.length === 1);
  const bridge = s.turns[0]!.req.bridge;
  const pending = bridge.requestPermission({ toolUseId: "ithaca-denial", toolName: "Write", input: {} });
  await until(() => client.frames("tool_approval_request").length === 1);
  const card = client.frames("tool_approval_request")[0];
  client.send({ type: "tool_denial", toolUseId: card.toolUseId, turnId: card.turnId, channel: "card", message: "Keep the raft unchanged." });
  expect(await pending).toMatchObject({ behavior: "deny" });
  const event = { kind: "permission_denied" as const, toolUseId: card.toolUseId, requestKind: "tool" as const, reason: "Backend acknowledged the denial." };
  bridge.activity!(event);
  bridge.activity!(event);
  expect(client.frames("tool_resolution")).toHaveLength(1);
  expect(client.frames("tool_resolution")[0]).toMatchObject({ toolUseId: card.toolUseId, outcome: "denied", channel: "card", sessionId: s.turns[0]!.sessionId });
  expect(s.host.coordinator.pendingApprovals.size).toBe(0);
});

for (const boundary of ["count", "chars", "sequence", "delegations"] as const) test(`unassigned recognition has a visible ${boundary} boundary`, async () => {
  const s = setup(); const client = await s.connect(); const conversation = await client.open();
  if (boundary === "delegations") {
    for (let i = 0; i <= CONVERSATION_LIMITS.maxPendingNativeRequests; i++) conversation.session.emit({ kind: "unassigned_delegation", handle: `unassigned-${i}`, offsetMs: i * 1000 });
  } else if (boundary === "sequence") {
    conversation.session.emit({ kind: "unassigned_input_fragment", sequence: 1, text: "A late note.", sessionInterval: { startMs: 10200, endMs: 10400 } });
  } else {
    const count = boundary === "count" ? CONVERSATION_LIMITS.maxFragmentsPerUtterance + 1 : 9;
    for (let i = 0; i < count; i++) conversation.session.emit({ kind: "unassigned_input_fragment", sequence: i, text: boundary === "chars" ? "x".repeat(2000) : "x", sessionInterval: { startMs: i * 1000, endMs: i * 1000 + 100 } });
  }
  await until(() => client.frames("conversation_closed").length > 0);
  expect(client.frames("conversation_closed")[0]).toMatchObject({ reason: boundary === "sequence" ? "correlation" : "backpressure" });
  const retained = client.frames("conversation_event").filter(f => f.event.kind === "unassigned_input_fragment");
  expect(retained.length).toBeLessThanOrEqual(CONVERSATION_LIMITS.maxFragmentsPerUtterance);
  expect(retained.reduce((n, f) => n + f.event.text.length, 0)).toBeLessThanOrEqual(CONVERSATION_LIMITS.maxUtteranceChars);
  expect(s.turns).toHaveLength(0);
});

test("unassigned native work never borrows a running request or the next committed input", async () => {
  const s = setup(); const client = await s.connect(); const conversation = await client.open();
  await client.speak(conversation, "u1", "Check the harbour.");
  client.commit(conversation, "u1", "r1", "Check the harbour.");
  await until(() => s.turns.length === 1);
  conversation.session.emit({ kind: "unassigned_delegation", handle: "unassigned", offsetMs: 10200 });
  conversation.session.emit({ kind: "unassigned_delegation", handle: "unassigned", offsetMs: 10200 });
  await until(() => client.frames("conversation_event").some(f => f.event.kind === "unassigned_delegation"));
  expect(client.frames("conversation_event").filter(f => f.event.kind === "unassigned_delegation")).toHaveLength(1);
  await client.speak(conversation, "u2", "Check the departure.");
  client.commit(conversation, "u2", "r2", "Check the departure.");
  s.turns[0]!.answer("The harbour note is ready.");
  await until(() => s.turns.length === 2);
  s.turns[1]!.answer("The departure note is ready.");
  await until(() => client.last("r2")?.state === "completed");
  expect(conversation.session.returned.every(r => !r.ref.nativeHandle)).toBe(true);
});

describe("contextual host tasks (#3070)", () => {
  test("native handle starts exactly one new task while three-turn dialogue continues", async () => {
    const s = setup({ capabilities: { contextualTasks: "supported" } });
    const client = await s.connect();
    const c = await client.open({ contextualTasks: true }); await client.capture(c);
    c.session.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Find the Ithaca departure note.", sessionInterval: { startMs: 0, endMs: 500 } });
    c.session.emit({ kind: "work_requested", handle: "departure" });
    await until(() => s.turns.length === 1);
    c.session.emit({ kind: "unassigned_input_fragment", sequence: 1, text: "What about the route?", sessionInterval: { startMs: 1000, endMs: 1500 } });
    c.session.emit({ kind: "output_transcript", outputId: "dialogue", sequence: 0, text: "We can discuss the route while I check." });
    c.session.emit({ kind: "unassigned_input_fragment", sequence: 2, text: "And the Sirens?", sessionInterval: { startMs: 2000, endMs: 2500 } });
    c.session.emit({ kind: "work_requested", handle: "departure" });
    await until(() => client.frames("conversation_event").some(f => f.event.text === "And the Sirens?"));
    expect(s.turns).toHaveLength(1);
    expect(new Set(client.frames("conversation_work").map(f => f.taskId)).size).toBe(1);
    const receipt = client.frames("conversation_work").at(-1);
    expect(receipt.provenance).toBe("contextual");
    expect(receipt.taskId).toBeTruthy();
    expect(receipt).not.toHaveProperty("utteranceId");
    expect(s.turns[0]!.req.prompt).toContain("Find the Ithaca departure note.");
    expect(s.turns[0]!.req.prompt).not.toContain("And the Sirens?");
    s.turns[0]!.answer("The departure note says to leave Ithaca at dawn.");
    await until(() => c.session.returned.length === 1);
    expect(c.session.returned[0]!.ref.nativeHandle).toBe("departure");
    expect(c.session.returned[0]!.ref).not.toHaveProperty("utteranceId");
    expect(c.session.returned[0]!.result.facts).toContain("dawn");
  });
});

for (const ending of ["withdraw", "cancel", "replace", "revoke"] as const) test(`contextual task never narrates late work after ${ending}`, async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" } });
  const client = await s.connect(); const c = await client.open({ contextualTasks: true }); await client.capture(c);
  c.session.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Find the Ithaca note.", sessionInterval: { startMs: 0, endMs: 20 } });
  c.session.emit({ kind: "work_requested", handle: "first" });
  await until(() => s.turns.length === 1);
  if (ending === "withdraw") c.session.emit({ kind: "work_withdrawn", handle: "first" });
  if (ending === "cancel") client.send({ type: "cancel", sessionId: s.turns[0]!.sessionId });
  if (ending === "replace") await client.open({ conversationId: c.id, contextualTasks: true });
  if (ending === "revoke") await client.close();
  s.turns[0]!.answer("The note was found.");
  await until(() => s.host.coordinator.running.size === 0);
  await settle();
  expect(c.session.returned).toHaveLength(0);
  expect(s.turns).toHaveLength(1);
});

test("contextual queued withdrawal and pre-request withdrawal cannot run or borrow manual work", async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" } });
  const client = await s.connect(); const c = await client.open({ contextualTasks: true }); await client.capture(c);
  await client.speak(c, "manual", "Review the raft plan.");
  client.commit(c, "manual", "manual-review", "Review the raft plan.");
  await until(() => s.turns.length === 1);
  c.session.emit({ kind: "work_requested", handle: "new-task" });
  c.session.emit({ kind: "work_withdrawn", handle: "new-task" });
  c.session.emit({ kind: "work_withdrawn", handle: "withdrawn-first" });
  c.session.emit({ kind: "work_requested", handle: "withdrawn-first" });
  await until(() => client.frames("conversation_work").some(f => f.provenance === "contextual" && f.state === "cancelled"));
  s.turns[0]!.answer("Manual work finished.");
  await until(() => client.last("manual-review")?.state === "completed");
  expect(c.session.returned.every(r => r.ref.nativeHandle === undefined)).toBe(true);
  expect(s.turns).toHaveLength(1);
});

test("contextual tasks bind separate handles before serial dispatch; duplicates and unchanged context do not replay", async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" } });
  const client = await s.connect(); const c = await client.open({ contextualTasks: true }); await client.capture(c);
  const input = (sequence: number, text: string) => c.session.emit({ kind: "unassigned_input_fragment", sequence, text, sessionInterval: { startMs: sequence * 30, endMs: sequence * 30 + 20 } });
  input(0, "Find the departure note."); c.session.emit({ kind: "work_requested", handle: "first" });
  await until(() => s.turns.length === 1);
  c.session.emit({ kind: "work_requested", handle: "duplicate-context" });
  input(1, "Also check the harbour note."); c.session.emit({ kind: "work_requested", handle: "second" });
  c.session.emit({ kind: "work_requested", handle: "second" });
  await until(() => client.frames("conversation_work").some(f => f.nativeHandle === "second"));
  expect(s.turns).toHaveLength(1);
  expect(client.frames("conversation_work").find(f => f.nativeHandle === "duplicate-context")?.state).toBe("refused");
  s.turns[0]!.answer("First note."); await until(() => s.turns.length === 2);
  expect(s.turns[1]!.req.prompt).toContain("harbour note");
  s.turns[1]!.answer("Second note."); await until(() => c.session.returned.length === 2);
  expect(c.session.returned.map(r => r.ref.nativeHandle)).toEqual(["first", "second"]);
  expect(new Set(c.session.returned.map(r => r.ref.requestId)).size).toBe(2);
});

test("contextual snapshot and queue bounds refuse explicitly without borrowing work", async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" } });
  const client = await s.connect(); const c = await client.open({ contextualTasks: true }); await client.capture(c);
  for (let i = 0; i < 5; i++) {
    c.session.emit({ kind: "unassigned_input_fragment", sequence: i, text: `Find Ithaca note ${i}.`, sessionInterval: { startMs: i * 100, endMs: i * 100 + 50 } });
    c.session.emit({ kind: "work_requested", handle: `bounded-${i}` });
  }
  await until(() => client.frames("conversation_work").some(f => f.nativeHandle === "bounded-4" && f.state === "refused"));
  await until(() => s.turns.length === 1);
  expect(s.turns).toHaveLength(1);
  expect(new Set(client.frames("conversation_work").filter(f => f.state !== "refused").map(f => f.taskId)).size).toBe(4);
  expect(client.frames("conversation_work").find(f => f.nativeHandle === "bounded-4")?.reason).toContain("capacity");
});

test("contextual work refuses aged recognition rather than inventing a fresh task", async () => {
  const original = Date.now;
  try {
    const s = setup({ capabilities: { contextualTasks: "supported" } });
    const client = await s.connect(); const c = await client.open({ contextualTasks: true }); await client.capture(c);
    Date.now = () => original();
    c.session.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Find the old Ithaca note.", sessionInterval: { startMs: 0, endMs: 10 } });
    await until(() => client.frames("conversation_event").some(f => f.event.kind === "unassigned_input_fragment"));
    Date.now = () => original() + 31_000;
    c.session.emit({ kind: "work_requested", handle: "aged" });
    await until(() => client.frames("conversation_work").some(f => f.nativeHandle === "aged"));
    expect(client.frames("conversation_work").at(-1)).toMatchObject({ state: "refused", recognized: "" });
    expect(s.turns).toHaveLength(0);
  } finally { Date.now = original; }
});

test("an older client cannot silently resume contextual receipts as reviewed work", async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" } });
  const client = await s.connect(); const c = await client.open({ contextualTasks: true }); await client.capture(c);
  c.session.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Find the Ithaca note.", sessionInterval: { startMs: 0, endMs: 20 } });
  c.session.emit({ kind: "work_requested", handle: "context-task" });
  await until(() => s.turns.length === 1);
  s.turns[0]!.answer("Found."); await until(() => c.session.returned.length === 1);
  client.send({ type: "conversation_start", conversationId: c.id });
  await until(() => client.frames("error").some(f => f.code === "CONVERSATION_CAPABILITY"));
  expect(client.frames("conversation_opened")).toHaveLength(1);
  expect(s.turns).toHaveLength(1);
});

test("contextual result submission followed by epoch loss stays unknown rather than claiming it was withheld", async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" }, holdReturns: true });
  const client = await s.connect(); const c = await client.open({ contextualTasks: true }); await client.capture(c);
  c.session.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Find the Ithaca note.", sessionInterval: { startMs: 0, endMs: 20 } });
  c.session.emit({ kind: "work_requested", handle: "pending-ack" });
  await until(() => s.turns.length === 1); s.turns[0]!.answer("The signal is a bronze owl.");
  await until(() => c.session.returned.length === 1);
  const requestId = c.session.returned[0]!.ref.requestId;
  expect(client.last(requestId).delivery).toBe("pending");
  const next = await client.open({ conversationId: c.id, contextualTasks: true });
  expect(client.last(requestId)).toMatchObject({ state: "completed", delivery: "unknown" });
  expect(next.session.returned).toHaveLength(0);
  expect(s.turns).toHaveLength(1);
});

test("resync recognition before fresh epoch audio never admits an automatic effect", async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" } });
  const client = await s.connect(); const c = await client.open({ contextualTasks: true });
  c.session.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Historical task: repair the raft.", sessionInterval: { startMs: 0, endMs: 10 } });
  c.session.emit({ kind: "work_requested", handle: "history-before-audio" });
  await until(() => client.frames("conversation_work").some(f => f.nativeHandle === "history-before-audio"));
  expect(client.frames("conversation_work").at(-1)?.state).toBe("refused");
  await client.capture(c);
  c.session.emit({ kind: "work_requested", handle: "history-after-audio" });
  await until(() => client.frames("conversation_work").some(f => f.nativeHandle === "history-after-audio"));
  expect(client.frames("conversation_work").at(-1)?.state).toBe("refused");
  expect(s.turns).toHaveLength(0);
});

test("a fresh host instance recovers scoped outcomes into a later epoch without dispatch or native replay", async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" } });
  const client = await s.connect(); const c = await client.open({ contextualTasks: true }); await client.capture(c);
  c.session.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Find the Ithaca note.", sessionInterval: { startMs: 0, endMs: 20 } });
  c.session.emit({ kind: "work_requested", handle: "durable-task" });
  await until(() => s.turns.length === 1); s.turns[0]!.answer("The signal is a bronze owl.");
  await until(() => !s.host.coordinator.isTurnActive());
  await s.host.catalog.settled!();
  s.host.conversations!.closeAll();
  Object.defineProperty(s.host, "conversations", { value: new ConversationHost(s.host, s.live.provider), configurable: true });
  const resumed = await s.connect();
  const next = await resumed.open({ conversationId: c.id, contextualTasks: true });
  expect(next.epoch).toBe(2);
  expect(next.opened.resync.work).toBe(1);
  expect(resumed.frames("conversation_work").at(-1)).toMatchObject({ provenance: "contextual", nativeHandle: "durable-task", state: "completed" });
  expect(next.session.returned).toHaveLength(0);
  expect(s.turns).toHaveLength(1);
});

test("a contextual provider's void return is not promoted to acceptance evidence", async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" } });
  const client = await s.connect(); const c = await client.open({ contextualTasks: true }); await client.capture(c);
  c.session.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Find the Ithaca note.", sessionInterval: { startMs: 0, endMs: 20 } });
  c.session.emit({ kind: "work_requested", handle: "unknown-acceptance" });
  await until(() => s.turns.length === 1); s.turns[0]!.answer("Found.");
  await until(() => c.session.returned.length === 1);
  const requestId = c.session.returned[0]!.ref.requestId;
  await until(() => client.last(requestId).delivery !== "pending");
  expect(client.last(requestId).delivery).toBe("unknown");
});


test("concurrent durable recovery has one owner and monotonically distinct epochs", async () => {
  const s = setup({ capabilities: { contextualTasks: "supported" } });
  const initial = await s.connect();
  const c = await initial.open({ contextualTasks: true });
  s.host.conversations!.closeAll();
  await s.host.catalog.settled!();
  Object.defineProperty(s.host, "conversations", { value: new ConversationHost(s.host, s.live.provider), configurable: true });
  const load = s.host.catalog.loadConversation!.bind(s.host.catalog);
  const releases: (() => void)[] = [];
  Object.defineProperty(s.host.catalog, "loadConversation", { value: async (...args: Parameters<typeof load>) => {
    const snapshot = await load(...args);
    await new Promise<void>(resolve => releases.push(resolve));
    return snapshot;
  } });
  const epochs: number[] = [];
  const save = s.host.catalog.saveConversationEpoch!.bind(s.host.catalog);
  Object.defineProperty(s.host.catalog, "saveConversationEpoch", { value: async (record: Parameters<typeof save>[0]) => {
    epochs.push(record.epoch); await save(record);
  } });
  const a = await s.connect(), b = await s.connect();
  a.send({ type: "conversation_start", conversationId: c.id, contextualTasks: true });
  b.send({ type: "conversation_start", conversationId: c.id, contextualTasks: true });
  await until(() => releases.length === 2);
  releases[0]!();
  await until(() => a.frames("conversation_opened").length === 1);
  releases[1]!();
  await until(() => b.frames("conversation_opened").length === 1);
  expect(epochs).toEqual([2, 3]);
  expect(a.frames("conversation_closed").at(-1)?.reason).toBe("replaced");
  expect(s.live.sessions.filter(session => !session.closed)).toHaveLength(1);
  const loser = s.live.sessions.at(-2)!, winner = s.live.sessions.at(-1)!;
  const active = { id: c.id, epoch: 3, session: winner };
  await b.capture(active);
  for (const [session, handle] of [[loser, "loser-task"], [winner, "winner-task"]] as const) {
    session.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Capture the Ithaca watch.", sessionInterval: { startMs: 0, endMs: 20 } });
    session.emit({ kind: "work_requested", handle });
  }
  await until(() => s.turns.length === 1);
  winner.emit({ kind: "work_requested", handle: "winner-task" });
  s.turns[0]!.answer("The watch was captured once.");
  await until(() => winner.returned.length === 1);
  await s.host.catalog.settled!();
  expect(s.turns).toHaveLength(1);
  expect(loser.returned).toHaveLength(0);
  expect(winner.returned[0]!.ref).toMatchObject({ epoch: 3, nativeHandle: "winner-task" });
  expect((await load(c.id, testPrincipal().id))?.epoch).toBe(3);
});

/**
 * The answer queue (#910) against the approved policies: Recovery B, Lifetime
 * B and Queue A. It drives the real queue and the real chat store; the
 * transport is a recording fake, so every frame the queue would put on the
 * socket is visible, and time is a hand-moved clock with hand-fired timers.
 *
 * The real socket, browser storage and two real tabs are exercised by
 * scripts/probes/answer-delivery/ in Chromium against the real host.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ClientMessage, ServerAskAnswerReceipt } from "@schlessera/brain-ui-sdk/protocol";

import { createBrainUiRoot } from "../src/root";
import { createAnswerDelivery, type SubmitAnswer } from "../src/lib/answer-delivery/manager";
import { createMemoryAnswerStorage, type AnswerStorage } from "../src/lib/answer-delivery/storage";
import { createTabHub } from "../src/lib/answer-delivery/tabs";
import {
  MAX_QUEUED_ANSWERS,
  type AnswerPayload,
  type QueuedAnswer,
} from "../src/lib/answer-delivery/types";

const T0 = Date.UTC(2026, 6, 12, 7, 41);
// Independent policy oracle from the answer-delivery decision: changing the
// implementation bounds must not move the admission, expiry or timer inputs.
const BYTE_LIMIT = 16 * 1024 * 1024;
const REPLAY_AGE = 24 * 60 * 60 * 1000;
const RECEIPT_WAIT = 5_000;

/** One nonempty, multibyte answer per kind. */
const PAYLOADS: Record<AnswerPayload["kind"], AnswerPayload> = {
  ask_user: { kind: "ask_user", answers: { "Which harbour first?": "Ithaca — Ἰθάκη" } },
  ask_user_list: { kind: "ask_user_list", answers: { oars: "Aboard" }, notes: { wine: "Maron’s gift \u{1F377}" } },
  ask_user_rank: { kind: "ask_user_rank", order: ["scheria", "aeolia"], unchanged: false },
  ask_user_form: { kind: "ask_user_form", answers: { course: { value: "Coast → Scheria" } }, visibleNodes: ["course"] },
};
const WIRE_PAYLOADS = {
  ask_user: { answers: { "Which harbour first?": "Ithaca — Ἰθάκη" } },
  ask_user_list: { answers: { oars: "Aboard" }, notes: { wine: "Maron’s gift \u{1F377}" } },
  ask_user_rank: { order: ["scheria", "aeolia"], unchanged: false },
  ask_user_form: { answers: { course: { value: "Coast → Scheria" } } },
};
const KINDS = Object.keys(PAYLOADS) as AnswerPayload["kind"][];

async function harness(options: { storage?: AnswerStorage | null; tabs?: ReturnType<ReturnType<typeof createTabHub>["tab"]> | null; now?: { t: number }; start?: boolean } = {}) {
  const root = createBrainUiRoot({ storage: null });
  const clock = options.now ?? { t: T0 };
  const timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
  const sent: ClientMessage[] = [];
  const net = { ready: false, receipts: true, principal: "principal-odysseus" as string | null, open: true, probes: 0 };
  const storage = options.storage === undefined ? createMemoryAnswerStorage() : options.storage;
  // This device has met its principal before, so an answer submitted while
  // offline knows whose it is.
  if (storage) await storage.setPrincipalKey("principal-odysseus").catch(() => {});
  const queue = createAnswerDelivery({
    chat: root.stores.chat,
    storage,
    tabs: options.tabs ?? null,
    transport: {
      send: (m) => {
        if (!net.ready || !net.open) return false;
        sent.push(m);
        return true;
      },
      ready: () => net.ready,
      supportsReceipts: () => net.receipts,
      principalKey: () => (net.ready ? net.principal : null),
      checkLiveness: () => {
        net.probes++;
      },
    },
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const timer = { at: clock.t + ms, fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h) => {
      if (h) (h as { cleared: boolean }).cleared = true;
    },
  });
  /** Move the clock and fire whatever came due. */
  const advance = (ms: number) => {
    clock.t += ms;
    for (const timer of [...timers]) {
      if (!timer.cleared && timer.at <= clock.t) {
        timer.cleared = true;
        timer.fn();
      }
    }
  };
  const connect = () => {
    net.ready = true;
    queue.connected();
  };
  const disconnect = () => {
    net.ready = false;
    queue.disconnected();
  };
  const receipt = (r: Omit<ServerAskAnswerReceipt, "type">) => queue.receipt({ type: "ask_answer_receipt", ...r });
  const delivery = (requestId = "req-1") => root.stores.chat.getState().deliveries[requestId];
  const answers = () => sent.filter((m) => m.type.endsWith("_response"));
  const statuses = () => sent.filter((m) => m.type === "ask_answer_status");
  /** A session buffer whose last assistant message holds the four kinds of request. */
  const chat = root.stores.chat.getState();
  chat.setActiveSession("s1");
  chat.startAssistantMessage("s1");
  chat.setAskUserRequest("s1", "req-1", [
    { question: "Which harbour first?", header: "Harbour", multiSelect: false, options: [{ label: "Ithaca", description: "Home" }] },
  ], "turn-1");
  const submit = (kind: AnswerPayload["kind"] = "ask_user", extra: Partial<SubmitAnswer> = {}) =>
    queue.submit({ requestId: "req-1", sessionId: "s1", turnId: "turn-1", payload: PAYLOADS[kind], ...extra });
  if (options.start !== false) await queue.start();
  return { root, queue, sent, net, storage, clock, advance, connect, disconnect, receipt, delivery, answers, statuses, submit, timers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a host hello overtakes the stored principal read", () => {
  test("logout during the principal read cannot restore an offline admission key", async () => {
    const storage = createMemoryAnswerStorage();
    let finishRead!: (key: string | null) => void;
    const read = new Promise<string | null>((resolve) => { finishRead = resolve; });
    const h = await harness({ storage: { ...storage, getPrincipalKey: () => read }, start: false });
    try {
      const started = h.queue.start();
      h.connect();
      await h.queue.logout();
      finishRead("principal-penelope");
      await started;
      h.disconnect();
      expect(await h.submit()).toBe("refused");
      expect(h.delivery()?.state).toBe("notSaved");
      expect(storage.records.size).toBe(0);
      expect(h.sent).toEqual([]);
    } finally {
      h.queue.dispose();
      h.root.dispose();
    }
  });

  for (const kind of KINDS) {
    for (const oldPrincipal of [null, "principal-penelope"]) {
      test(`${kind}: a late ${oldPrincipal ?? "empty"} read cannot replace the connected principal for offline Submit`, async () => {
        const storage = createMemoryAnswerStorage();
        let finishRead!: (key: string | null) => void;
        const read = new Promise<string | null>((resolve) => { finishRead = resolve; });
        const h = await harness({ storage: { ...storage, getPrincipalKey: () => read }, start: false });
        try {
          const started = h.queue.start();
          h.connect();
          finishRead(oldPrincipal);
          await started;
          h.disconnect();
          expect(await h.submit(kind)).toBe("admitted");
          expect(h.delivery()?.state).toBe("queued");
          expect(storage.records.size).toBe(1);
          expect([...storage.records.values()][0]).toMatchObject({
            principalKey: "principal-odysseus", requestId: "req-1", sessionId: "s1", payload: PAYLOADS[kind], sent: false,
          });
          expect(h.sent).toEqual([]);
        } finally {
          h.queue.dispose();
          h.root.dispose();
        }
      });
    }
  }
});

describe("submitting online", () => {
  for (const kind of KINDS) {
    test(`${kind}: saved, sent with its binding, and answered only on the receipt`, async () => {
      const h = await harness();
      h.connect();
      const pending = h.submit(kind);
      expect(h.delivery()?.state).toBe("saving");
      await pending;
      expect(h.answers()).toHaveLength(1);
      const frame = h.answers()[0] as ClientMessage & { submissionId: string };
      expect(frame).toMatchObject({ type: `${kind}_response`, requestId: "req-1", turnId: "turn-1", sessionId: "s1", ...WIRE_PAYLOADS[kind] });
      expect(frame.submissionId).toBeTruthy();
      // Sent is not accepted.
      expect(h.delivery()?.state).toBe("awaiting");
      expect((h.storage as ReturnType<typeof createMemoryAnswerStorage>).records.size).toBe(1);
      h.receipt({ requestId: "req-1", submissionId: frame.submissionId, state: "accepted" });
      expect(h.delivery()?.state).toBe("answered");
      expect(h.delivery()?.payload).toEqual(PAYLOADS[kind]);
      expect((h.storage as ReturnType<typeof createMemoryAnswerStorage>).records.size).toBe(0);
    });
  }

  test("a second tap while the first is saving is not a second answer", async () => {
    const h = await harness();
    h.connect();
    await Promise.all([h.submit(), h.submit(), h.submit()]);
    expect(h.answers()).toHaveLength(1);
  });

  test("no receipt in 5 s: probe the socket and ask again, same submission", async () => {
    const h = await harness();
    h.connect();
    await h.submit();
    const id = (h.answers()[0] as { submissionId: string }).submissionId;
    h.advance(RECEIPT_WAIT - 1);
    expect(h.net.probes).toBe(0);
    h.advance(1);
    expect(h.net.probes).toBe(1);
    expect(h.statuses()).toEqual([{ type: "ask_answer_status", requestId: "req-1", submissionId: id, sessionId: "s1" }]);
    expect(h.delivery()?.state).toBe("awaiting");
  });

  test("a card that does not know its turn asks the host before answering", async () => {
    const h = await harness();
    h.connect();
    await h.submit("ask_user", { turnId: undefined });
    expect(h.answers()).toEqual([]);
    const id = (h.statuses()[0] as { submissionId: string }).submissionId;
    h.receipt({ requestId: "req-1", submissionId: id, state: "pending", turnId: "turn-1", sessionId: "s1" });
    expect(h.answers()[0]).toMatchObject({ submissionId: id, turnId: "turn-1" });
  });

  test("a closed receipt is final and visible, and nothing is replayed", async () => {
    const h = await harness();
    h.connect();
    await h.submit();
    const id = (h.answers()[0] as { submissionId: string }).submissionId;
    h.receipt({ requestId: "req-1", submissionId: id, state: "closed", reason: "ended" });
    expect(h.delivery()).toMatchObject({ state: "closed", reason: "ended" });
    h.disconnect();
    h.connect();
    expect(h.sent).toHaveLength(1);
  });
});

describe("submitting offline", () => {
  test("the answer is committed before it is shown as queued", async () => {
    const storage = createMemoryAnswerStorage();
    const h = await harness({ storage });
    let committed = false;
    const put = storage.put;
    storage.put = async (item) => {
      await put(item);
      committed = true;
    };
    const pending = h.submit();
    expect(h.delivery()?.state).toBe("saving");
    expect(committed).toBe(false);
    await pending;
    expect(committed).toBe(true);
    expect(h.delivery()?.state).toBe("queued");
    expect(h.sent).toEqual([]);
  });

  test("a storage failure shows Not saved, sends nothing, and keeps the card editable", async () => {
    const storage = createMemoryAnswerStorage();
    storage.put = async () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
    const h = await harness({ storage });
    h.connect();
    await h.submit();
    expect(h.delivery()?.state).toBe("notSaved");
    expect(h.sent).toEqual([]);
    const exchange = h.root.stores.chat.getState().buffers.s1!.messages.at(-1)!.askUserExchanges![0]!;
    expect(exchange.answers).toBeUndefined();
  });

  test("no storage at all: Not saved", async () => {
    const h = await harness({ storage: null });
    h.connect();
    await h.submit();
    expect(h.delivery()?.state).toBe("notSaved");
  });

  test("reconnecting asks for status first, then sends only while the host waits", async () => {
    const h = await harness();
    await h.submit();
    h.connect();
    expect(h.answers()).toEqual([]);
    const id = (h.statuses()[0] as { submissionId: string }).submissionId;
    h.receipt({ requestId: "req-1", submissionId: id, state: "pending", turnId: "turn-1", sessionId: "s1" });
    expect(h.answers()).toHaveLength(1);
    expect((h.answers()[0] as { submissionId: string }).submissionId).toBe(id);
  });

  test("an answer the host already took, whose receipt was lost, is answered without sending it again", async () => {
    const h = await harness();
    h.connect();
    await h.submit();
    const id = (h.answers()[0] as { submissionId: string }).submissionId;
    h.disconnect();
    h.connect();
    expect(h.statuses()).toHaveLength(1);
    h.receipt({ requestId: "req-1", submissionId: id, state: "accepted" });
    expect(h.delivery()?.state).toBe("answered");
    expect(h.answers()).toHaveLength(1);
  });

  test("Cancel sending stops replay; the host's status decides whether Edit is offered", async () => {
    const h = await harness();
    await h.submit();
    await h.queue.cancel("req-1");
    expect(h.delivery()?.state).toBe("cancelled");
    expect(h.delivery()?.editable).toBeUndefined();
    expect((h.storage as ReturnType<typeof createMemoryAnswerStorage>).records.size).toBe(0);
    h.connect();
    // Nothing is replayed; the host is only asked whether Edit is honest.
    expect(h.answers()).toEqual([]);
    expect(h.statuses()).toHaveLength(1);
    const id = (h.statuses()[0] as { submissionId: string }).submissionId;
    h.receipt({ requestId: "req-1", submissionId: id, state: "pending", turnId: "turn-1" });
    expect(h.delivery()).toMatchObject({ state: "cancelled", editable: true });
    expect(h.answers()).toEqual([]);
  });

  test("dismissing a question drops an answer that was never admitted", async () => {
    const h = await harness({ storage: null });
    h.connect();
    await h.submit();
    expect(h.delivery()?.state).toBe("notSaved");
    h.queue.dismissed("req-1");
    expect(h.delivery()).toBeUndefined();
    await h.queue.retry("req-1");
    expect(h.delivery()).toBeUndefined();
  });

  test("Cancel asks the host; still waiting allows Edit, which reopens the card", async () => {
    const h = await harness();
    await h.submit();
    h.connect();
    const id = (h.statuses()[0] as { submissionId: string }).submissionId;
    h.sent.length = 0;
    // The status reply has not come back yet; the answer was never sent.
    await h.queue.cancel("req-1");
    const query = h.statuses()[0] as { submissionId: string };
    expect(query.submissionId).toBe(id);
    h.receipt({ requestId: "req-1", submissionId: id, state: "pending", turnId: "turn-1" });
    expect(h.delivery()).toMatchObject({ state: "cancelled", editable: true });
    expect(h.answers()).toEqual([]);
    h.queue.edit("req-1");
    expect(h.delivery()).toBeUndefined();
    const exchange = h.root.stores.chat.getState().buffers.s1!.messages.at(-1)!.askUserExchanges![0]!;
    expect(exchange.answers).toBeUndefined();
  });

  test("a cancel the host already accepted shows Answered, never Cancelled", async () => {
    const h = await harness();
    await h.submit();
    const id = h.queue.held()[0]!.submissionId;
    await h.queue.cancel("req-1");
    h.net.ready = true;
    h.receipt({ requestId: "req-1", submissionId: id, state: "accepted" });
    expect(h.delivery()?.state).toBe("answered");
  });

  test("a possibly delivered answer cannot be cancelled", async () => {
    const h = await harness();
    h.connect();
    await h.submit();
    h.disconnect();
    await h.queue.cancel("req-1");
    expect(h.delivery()?.state).toBe("awaiting");
    expect(h.queue.held()).toHaveLength(1);
  });
});

describe("Lifetime B: reload", () => {
  for (const kind of KINDS) {
    test(`${kind}: a reloaded page restores the full answer and settles it once`, async () => {
      const storage = createMemoryAnswerStorage();
      const clock = { t: T0 };
      const first = await harness({ storage, now: clock });
      await first.submit(kind);
      const stored = [...storage.records.values()][0] as QueuedAnswer;
      first.queue.dispose();

      clock.t += 60_000;
      const second = await harness({ storage, now: clock });
      await second.queue.start();
      expect(second.delivery()).toMatchObject({ state: "queued", payload: PAYLOADS[kind], submittedAt: T0, submissionId: stored.submissionId });
      second.connect();
      second.receipt({ requestId: "req-1", submissionId: stored.submissionId, state: "pending", turnId: "turn-1", sessionId: "s1" });
      expect(second.answers()).toHaveLength(1);
      expect(second.answers()[0]).toMatchObject({ submissionId: stored.submissionId, turnId: "turn-1" });
      second.receipt({ requestId: "req-1", submissionId: stored.submissionId, state: "accepted" });
      second.receipt({ requestId: "req-1", submissionId: stored.submissionId, state: "accepted" });
      expect(second.delivery()?.state).toBe("answered");
      expect(storage.records.size).toBe(0);
      expect(second.answers()).toHaveLength(1);
    });
  }

  test("a restored answer for a request the host no longer knows is closed, not resurrected", async () => {
    const storage = createMemoryAnswerStorage();
    const first = await harness({ storage });
    await first.submit();
    const id = first.queue.held()[0]!.submissionId;
    const second = await harness({ storage });
    await second.queue.start();
    second.connect();
    second.receipt({ requestId: "req-1", submissionId: id, state: "closed", reason: "not_recognized" });
    expect(second.delivery()).toMatchObject({ state: "closed", reason: "not_recognized" });
    expect(second.answers()).toEqual([]);
  });

  test("a corrupt record is dropped and reported, never sent", async () => {
    const storage = createMemoryAnswerStorage();
    storage.records.set("bad", { v: 1, submissionId: "bad", payload: { kind: "ask_user", answers: "not a map" } });
    let corrupt = 0;
    const root = createBrainUiRoot({ storage: null });
    const sent: ClientMessage[] = [];
    const queue = createAnswerDelivery({
      chat: root.stores.chat,
      storage,
      tabs: null,
      onCorruptRecord: () => corrupt++,
      transport: { send: (m) => (sent.push(m), true), ready: () => true, supportsReceipts: () => true, principalKey: () => "p", checkLiveness: () => {} },
    });
    await queue.start();
    queue.connected();
    expect(corrupt).toBe(1);
    expect(storage.records.size).toBe(0);
    expect(sent).toEqual([]);
  });

  test("storage that cannot be read restores nothing and refuses to promise durability", async () => {
    const storage = createMemoryAnswerStorage();
    storage.load = async () => {
      throw new Error("unavailable");
    };
    const h = await harness({ storage });
    h.connect();
    await h.submit();
    expect(h.delivery()?.state).toBe("notSaved");
  });
});

describe("Queue A bounds", () => {
  async function filled(count: number, sessionPrefix = "req-q") {
    const h = await harness();
    for (let i = 0; i < count; i++) {
      await h.queue.submit({ requestId: `${sessionPrefix}${i}`, sessionId: "s1", turnId: "turn-1", payload: PAYLOADS.ask_user });
    }
    return h;
  }

  test("the 17th answer is refused visibly; the 16 queued are unchanged", async () => {
    const h = await filled(MAX_QUEUED_ANSWERS);
    expect(h.queue.held()).toHaveLength(16);
    const before = JSON.stringify(h.queue.held());
    await h.submit();
    expect(h.delivery()).toMatchObject({ state: "full", full: "count" });
    expect(JSON.stringify(h.queue.held())).toBe(before);
    // Nothing was admitted, so the card is still editable.
    const exchange = h.root.stores.chat.getState().buffers.s1!.messages.at(-1)!.askUserExchanges![0]!;
    expect(exchange.answers).toBeUndefined();
  });

  test("Try again admits it once there is room", async () => {
    const h = await filled(MAX_QUEUED_ANSWERS);
    await h.submit();
    expect(h.delivery()?.state).toBe("full");
    h.connect();
    const first = h.queue.held()[0]!;
    h.receipt({ requestId: first.requestId, submissionId: first.submissionId, state: "accepted" });
    await h.queue.retry("req-1");
    expect(h.delivery()?.state).toBe("awaiting");
  });

  test("the byte budget is independent of the count, and exact", async () => {
    const h = await harness();
    // Large multibyte answers that are still valid frames: up to 64 answers
    // of up to 20,000 characters each, every theta two UTF-8 bytes.
    const big = (chars: number): AnswerPayload => {
      const answers: Record<string, string> = {};
      for (let i = 0; chars > 0; i++) {
        const n = Math.min(chars, 20_000);
        answers[`Question ${i}`] = "\u03B8".repeat(n);
        chars -= n;
      }
      return { kind: "ask_user", answers };
    };
    const probe = (payload: AnswerPayload, requestId: string) =>
      Buffer.byteLength(JSON.stringify({ v: 1, submissionId: "00000000-0000-4000-8000-000000000000", principalKey: "principal-odysseus", requestId, sessionId: "s1", turnId: "turn-1", payload, submittedAt: T0, sent: false }), "utf8");
    const FULL = 1_200_000; // 2.4 MB of thetas per answer, 60 keys of 64
    let used = 0;
    let n = 0;
    while (BYTE_LIMIT - used > probe(big(FULL), `big-${n}`)) {
      used += probe(big(FULL), `big-${n}`);
      await h.queue.submit({ requestId: `big-${n}`, sessionId: "s1", turnId: "turn-1", payload: big(FULL) });
      n++;
    }
    // The last one fills the budget to the byte: thetas for the bulk, then
    // single-byte characters for the odd remainder, in a key with room.
    const last = `big-${n}`;
    const target = BYTE_LIMIT - used;
    let chars = Math.floor((target - probe(big(0), last)) / 2);
    let payload: AnswerPayload = big(chars);
    for (;;) {
      payload = big(chars);
      const answers = (payload as { answers: Record<string, string> }).answers;
      const keys = Object.keys(answers);
      const gap = target - probe(payload, last);
      const tail = keys[keys.length - 1]!;
      if (gap >= 0 && answers[tail]!.length + gap <= 20_000) {
        answers[tail] += "a".repeat(gap);
        break;
      }
      chars -= 500;
    }
    expect(probe(payload, last)).toBe(BYTE_LIMIT - used);
    await h.queue.submit({ requestId: last, sessionId: "s1", turnId: "turn-1", payload });
    expect(h.queue.held()).toHaveLength(n + 1);
    expect(n + 1).toBeLessThan(MAX_QUEUED_ANSWERS);
    const total = h.queue.held().reduce((sum, { owned: _o, ...item }) => sum + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
    expect(total).toBe(BYTE_LIMIT);
    // One more small answer does not fit, though fewer than 16 are queued.
    await h.submit();
    expect(h.delivery()).toMatchObject({ state: "full", full: "bytes" });
  });

  test("replay stops at exactly 24 hours from the original Submit; a reload does not reset it", async () => {
    const storage = createMemoryAnswerStorage();
    const clock = { t: T0 };
    const first = await harness({ storage, now: clock });
    await first.submit();
    first.queue.dispose();
    clock.t = T0 + REPLAY_AGE - 1;
    const second = await harness({ storage, now: clock });
    await second.queue.start();
    expect(second.delivery()?.state).toBe("queued");
    expect(second.delivery()?.submittedAt).toBe(T0);
    second.advance(1);
    expect(second.delivery()?.state).toBe("expired");
    expect(storage.records.size).toBe(0);
    second.connect();
    expect(second.sent).toEqual([]);
  });

  test("an answer already past 24 hours at load is expired, not replayed", async () => {
    const storage = createMemoryAnswerStorage();
    const clock = { t: T0 };
    await (await harness({ storage, now: clock })).submit();
    clock.t = T0 + REPLAY_AGE;
    const later = await harness({ storage, now: clock });
    await later.queue.start();
    later.connect();
    expect(later.delivery()?.state).toBe("expired");
    expect(later.sent).toEqual([]);
  });
});

describe("review fixes (#910)", () => {
  test("two Submits racing for the last place: one is admitted, one is Full", async () => {
    const h = await harness();
    for (let i = 0; i < MAX_QUEUED_ANSWERS - 1; i++) {
      await h.queue.submit({ requestId: `req-q${i}`, sessionId: "s1", turnId: "turn-1", payload: PAYLOADS.ask_user });
    }
    await Promise.all([
      h.queue.submit({ requestId: "race-a", sessionId: "s1", turnId: "turn-1", payload: PAYLOADS.ask_user }),
      h.queue.submit({ requestId: "race-b", sessionId: "s1", turnId: "turn-1", payload: PAYLOADS.ask_user }),
    ]);
    expect(h.queue.held()).toHaveLength(MAX_QUEUED_ANSWERS);
    expect([h.delivery("race-a")?.state, h.delivery("race-b")?.state].sort()).toEqual(["full", "queued"]);
    expect((h.storage as ReturnType<typeof createMemoryAnswerStorage>).records.size).toBe(MAX_QUEUED_ANSWERS);
  });

  test("two tabs racing for the last place: one is admitted", async () => {
    const hub = createTabHub();
    const storage = createMemoryAnswerStorage();
    const a = await harness({ storage, tabs: hub.tab() });
    const b = await harness({ storage, tabs: hub.tab() });
    for (let i = 0; i < MAX_QUEUED_ANSWERS - 1; i++) {
      await a.queue.submit({ requestId: `req-q${i}`, sessionId: "s1", turnId: "turn-1", payload: PAYLOADS.ask_user });
    }
    await Promise.all([
      a.queue.submit({ requestId: "race-a", sessionId: "s1", turnId: "turn-1", payload: PAYLOADS.ask_user }),
      b.queue.submit({ requestId: "race-b", sessionId: "s1", turnId: "turn-1", payload: PAYLOADS.ask_user }),
    ]);
    expect(storage.records.size).toBe(MAX_QUEUED_ANSWERS);
    expect([a.delivery("race-a")?.state, b.delivery("race-b")?.state].filter((s) => s === "full")).toHaveLength(1);
  });

  test("a host without receipts says Update needed even before this device knows its principal", async () => {
    const h = await harness({ storage: createMemoryAnswerStorage() });
    await h.storage!.setPrincipalKey("");
    h.net.receipts = false;
    h.net.principal = null;
    h.connect();
    await h.submit();
    expect(h.delivery()?.state).toBe("update");
    expect(h.sent).toEqual([]);
  });

  test("a page that wakes past the 24-hour bound expires the answer before anything is sent", async () => {
    const storage = createMemoryAnswerStorage();
    const clock = { t: T0 };
    const first = await harness({ storage, now: clock });
    await first.submit();
    first.queue.dispose();
    clock.t = T0 + REPLAY_AGE - 10;
    const second = await harness({ storage, now: clock });
    expect(second.delivery()?.state).toBe("queued");
    // Frozen: the clock moves, no timer fires, then the socket comes back.
    clock.t = T0 + REPLAY_AGE;
    second.connect();
    expect(second.delivery()?.state).toBe("expired");
    expect(second.sent).toEqual([]);
  });

  test("an answer restored after the hello, under another principal, is signed out", async () => {
    const storage = createMemoryAnswerStorage();
    const first = await harness({ storage });
    await first.submit();
    first.queue.dispose();
    // The hello arrives while the second page is still reading storage.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = storage.load;
    storage.load = async () => {
      await gate;
      return load();
    };
    const root = createBrainUiRoot({ storage: null });
    const sent: ClientMessage[] = [];
    const queue = createAnswerDelivery({
      chat: root.stores.chat,
      storage,
      tabs: null,
      now: () => T0,
      transport: { send: (m) => (sent.push(m), true), ready: () => true, supportsReceipts: () => true, principalKey: () => "principal-penelope", checkLiveness: () => {} },
    });
    const started = queue.start();
    queue.connected();
    release();
    await started;
    expect(root.stores.chat.getState().deliveries["req-1"]?.state).toBe("signedOut");
    expect(sent).toEqual([]);
    expect(storage.records.size).toBe(0);
  });
});

describe("second review pass (#910)", () => {
  test("signing out while an answer is being written takes it back", async () => {
    const storage = createMemoryAnswerStorage();
    const h = await harness({ storage });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const put = storage.put;
    storage.put = async (item) => {
      await gate;
      await put(item);
    };
    const pending = h.submit();
    await flush();
    const out = h.queue.logout();
    release();
    expect(await pending).toBe("refused");
    await out;
    expect(storage.records.size).toBe(0);
    expect(h.delivery()?.state).toBe("signedOut");
    h.connect();
    expect(h.sent).toEqual([]);
  });

  test("an answer for a host without receipts is kept, so Reload app does not lose it", async () => {
    const storage = createMemoryAnswerStorage();
    const old = await harness({ storage });
    old.net.receipts = false;
    old.connect();
    expect(await old.submit()).toBe("admitted");
    expect(old.delivery()?.state).toBe("update");
    expect(old.sent).toEqual([]);
    expect(storage.records.size).toBe(1);
    old.queue.dispose();
    // Reloaded against an updated host: status first, then the same answer.
    const fresh = await harness({ storage });
    fresh.connect();
    const id = (fresh.statuses()[0] as { submissionId: string }).submissionId;
    fresh.receipt({ requestId: "req-1", submissionId: id, state: "pending", turnId: "turn-1", sessionId: "s1" });
    expect(fresh.answers()).toHaveLength(1);
  });

  test("a refused admission says so to its caller, so a composer can keep the text", async () => {
    const h = await harness({ storage: null });
    h.connect();
    expect(await h.submit("ask_user", { payload: { kind: "ask_user", answers: { q: "typed" }, typed: true } })).toBe("refused");
  });
});

describe("third review pass (#910)", () => {
  test("a cancel whose deletion fails is not reported as cancelled and is not dropped", async () => {
    const storage = createMemoryAnswerStorage();
    const h = await harness({ storage });
    await h.submit();
    storage.remove = async () => {
      throw new DOMException("busy", "UnknownError");
    };
    await h.queue.cancel("req-1");
    expect(h.delivery()?.state).toBe("queued");
    expect(storage.records.size).toBe(1);
    expect(h.queue.held()).toHaveLength(1);
  });

  test("a restore that read storage before a logout does not bring the answers back", async () => {
    const storage = createMemoryAnswerStorage();
    const first = await harness({ storage });
    await first.submit();
    first.queue.dispose();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = storage.load;
    storage.load = async () => {
      const snapshot = await load();
      await gate;
      return snapshot;
    };
    const root = createBrainUiRoot({ storage: null });
    const sent: ClientMessage[] = [];
    const queue = createAnswerDelivery({
      chat: root.stores.chat,
      storage,
      tabs: null,
      now: () => T0,
      transport: { send: (m) => (sent.push(m), true), ready: () => true, supportsReceipts: () => true, principalKey: () => "principal-odysseus", checkLiveness: () => {} },
    });
    const started = queue.start();
    await flush();
    const out = queue.logout();
    release();
    await started;
    await out;
    expect(queue.held()).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("a storage read that fails once is retried on the next connection", async () => {
    const storage = createMemoryAnswerStorage();
    const first = await harness({ storage });
    await first.submit();
    first.queue.dispose();
    const load = storage.load;
    let failing = true;
    storage.load = async () => {
      if (failing) throw new Error("transient");
      return load();
    };
    const second = await harness({ storage });
    expect(second.queue.held()).toEqual([]);
    failing = false;
    second.connect();
    await flush();
    await flush();
    expect(second.queue.held()).toHaveLength(1);
    expect(second.statuses()).toHaveLength(1);
  });
});

describe("principals and peers", () => {
  test("a connection with another principal signs the queued answer out, unsent", async () => {
    const h = await harness();
    await h.submit();
    h.net.principal = "principal-penelope";
    h.connect();
    expect(h.delivery()?.state).toBe("signedOut");
    expect(h.sent).toEqual([]);
    expect((h.storage as ReturnType<typeof createMemoryAnswerStorage>).records.size).toBe(0);
  });

  test("logout clears the queue and its replay authority", async () => {
    const h = await harness();
    await h.submit();
    await h.queue.logout();
    expect(h.delivery()?.state).toBe("signedOut");
    h.connect();
    expect(h.sent).toEqual([]);
  });

  test("a host without receipt support shows Update needed and settles nothing", async () => {
    const h = await harness();
    h.net.receipts = false;
    h.connect();
    await h.submit();
    expect(h.delivery()?.state).toBe("update");
    expect(h.sent).toEqual([]);
  });
});

describe("two tabs", () => {
  test("one tab owns a submission; the other mirrors it read-only and takes over when it closes", async () => {
    const hub = createTabHub();
    const storage = createMemoryAnswerStorage();
    const a = await harness({ storage, tabs: hub.tab() });
    const b = await harness({ storage, tabs: hub.tab() });
    await a.submit();
    await flush();
    expect(a.delivery()?.mirror).toBeUndefined();
    expect(b.delivery()).toMatchObject({ state: "queued", mirror: true });
    // Both tabs connect; only the owner talks to the host about it.
    a.connect();
    b.connect();
    expect(a.statuses()).toHaveLength(1);
    expect(b.sent).toEqual([]);
    // B cannot submit a second answer to the same request.
    await b.submit();
    expect(b.sent).toEqual([]);
    a.queue.dispose();
    await flush();
    await flush();
    expect(b.delivery()?.mirror).toBeUndefined();
    expect(b.statuses()).toHaveLength(1);
    expect((b.statuses()[0] as { submissionId: string }).submissionId).toBe((a.statuses()[0] as { submissionId: string }).submissionId);
  });

  test("the owner's outcome reaches the mirror", async () => {
    const hub = createTabHub();
    const storage = createMemoryAnswerStorage();
    const a = await harness({ storage, tabs: hub.tab() });
    const b = await harness({ storage, tabs: hub.tab() });
    a.connect();
    await a.submit();
    await flush();
    const id = (a.answers()[0] as { submissionId: string }).submissionId;
    a.receipt({ requestId: "req-1", submissionId: id, state: "accepted" });
    expect(b.delivery()).toMatchObject({ state: "answered", mirror: true });
  });
});

beforeEach(() => {});


for(const operation of ["cancel", "failed admission"] as const) test(`${operation} completing after disposal cannot publish old answer payloads`,async()=>{
 const storage=createMemoryAnswerStorage(); const h=await harness({storage});
 let release!:()=>void; const gate=new Promise<void>(yes=>release=yes); let pending:Promise<unknown>;
 if(operation === "cancel") {
  await h.submit(); expect(h.delivery()?.payload,"queued protected payload is nonempty").toEqual(PAYLOADS.ask_user);
  const remove=storage.remove; storage.remove=async(id)=>{await gate;await remove(id);};
  pending=h.queue.cancel("req-1");
 } else {
  storage.put=async()=>{await gate;throw new Error("device write refused");};
  pending=h.submit(); await flush(); expect(h.delivery()?.payload,"pending protected payload is nonempty").toEqual(PAYLOADS.ask_user);
 }
 h.queue.dispose(); h.root.stores.chat.setState(h.root.stores.chat.getInitialState(),true);
 release(); await pending;
 expect(h.root.stores.chat.getState().deliveries,"disposed continuation cannot repopulate protected answers").toEqual({});
 h.root.dispose();
});

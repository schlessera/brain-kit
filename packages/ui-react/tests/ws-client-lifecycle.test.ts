/**
 * The connection's parts, each driven directly rather than through the whole
 * `createWebSocketClient` closure (#1362). The runtime suites
 * (`reconnect-reattach`, `session-restoration`, `connection-continuity-runtime`)
 * remain the behavioural guard of the composition; these pin the ordering
 * rules each part owns, so breaking one fails here first.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BrainUiClient, BrainUiClientOptions } from "@schlessera/brain-ui-sdk/client";
import type { ClientMessage, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import { createDeltaBuffer } from "../src/ws-client/delta-buffer.js";
import { createReconnectHealing } from "../src/ws-client/reconnect.js";
import { createRestorationDriver } from "../src/ws-client/restoration.js";
import { createOutbound } from "../src/ws-client/outbound.js";
import { createSocketLease } from "../src/ws-client/socket-lease.js";
import { createTurnRetries } from "../src/ws-client/turn-retry.js";
import { dispatchServerMessage } from "../src/hooks/websocket-handlers/index.js";
import type { DispatchContext } from "../src/hooks/websocket-handlers/types.js";

const roots: BrainUiRoot[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.dispose();
  for (const restore of restores.splice(0).reverse()) restore();
});

function makeRoot(): BrainUiRoot {
  const root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://ithaca-harbour.example" } });
  roots.push(root);
  return root;
}

/** Replace a global for one test, restoring its complete property descriptor. */
function replaceGlobal(name: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  restores.push(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  });
}

function recorder() {
  const sent: ClientMessage[] = [];
  return { sent, send: (message: ClientMessage) => { sent.push(message); return true; } };
}

describe("delta buffer", () => {
  test("coalesces same-kind deltas per frame and keeps kind changes in arrival order", () => {
    let frame: (() => void) | undefined;
    replaceGlobal("requestAnimationFrame", (callback: () => void) => { frame = callback; return 1; });
    replaceGlobal("cancelAnimationFrame", () => {});
    const writes: string[] = [];
    const chat = { getState: () => ({
      appendText: (key: string | null, text: string) => writes.push(`${key}:text:${text}`),
      appendThinking: (key: string | null, text: string) => writes.push(`${key}:thinking:${text}`),
    }) } as unknown as Parameters<typeof createDeltaBuffer>[0];
    const deltas = createDeltaBuffer(chat);
    deltas.enqueue("s1", "text", "Sail ");
    deltas.enqueue("s1", "text", "past ");
    deltas.enqueue("s1", "thinking", "the Sirens sing");
    deltas.enqueue("s1", "text", "the Sirens.");
    deltas.enqueue("s2", "text", "Rest at Aeaea.");
    expect(writes).toEqual([]);
    frame?.();
    expect(writes).toEqual([
      "s1:text:Sail past ",
      "s1:thinking:the Sirens sing",
      "s1:text:the Sirens.",
      "s2:text:Rest at Aeaea.",
    ]);
    // A flush with nothing buffered writes nothing more.
    deltas.flush();
    expect(writes).toHaveLength(4);
  });
});

describe("reconnect healing", () => {
  test("a page that never lost its socket replays nothing", () => {
    const root = makeRoot();
    const out = recorder();
    const healing = createReconnectHealing(root, out.send);
    root.stores.chat.getState().setActiveSession("s1");
    root.stores.chat.getState().addUserMessage("s1", "Sail past the Sirens", "typed");
    healing.connected();
    expect(out.sent).toEqual([]);
  });

  test("an idle transcript replays at once, and only once", () => {
    const root = makeRoot();
    const out = recorder();
    const healing = createReconnectHealing(root, out.send);
    root.stores.chat.getState().setActiveSession("s1");
    root.stores.chat.getState().addUserMessage("s1", "Sail past the Sirens", "typed");
    healing.disconnected();
    healing.connected();
    expect(out.sent).toEqual([{ type: "session_resume", sessionId: "s1" }]);
    healing.resyncIfNeeded("s1");
    expect(out.sent).toHaveLength(1);
  });

  test("a streaming transcript reattaches, and only its own turn's end replays it", () => {
    const root = makeRoot();
    const out = recorder();
    const healing = createReconnectHealing(root, out.send);
    root.stores.chat.getState().setActiveSession("s1");
    root.stores.chat.getState().addUserMessage("s1", "Sail past the Sirens", "typed");
    root.stores.chat.getState().startAssistantMessage("s1");
    healing.disconnected();
    healing.connected();
    expect(out.sent).toEqual([{ type: "session_resume", sessionId: "s1" }]);
    expect(healing.reattaching()).toBe("s1");
    // A background session settling first cannot consume the pending resync.
    healing.resyncIfNeeded("s2");
    expect(out.sent).toHaveLength(1);
    healing.resyncIfNeeded("s1");
    expect(out.sent).toEqual([{ type: "session_resume", sessionId: "s1" }, { type: "session_resume", sessionId: "s1" }]);
    // A later drop forgets the reattach before the next socket decides.
    healing.disconnected();
    expect(healing.reattaching()).toBeNull();
  });

  test("a follow-up refresh takes the turn end before the resync, so history is read once", () => {
    const root = makeRoot();
    const out = recorder();
    const healing = createReconnectHealing(root, out.send);
    root.stores.chat.getState().setActiveSession("s1");
    root.stores.chat.getState().addUserMessage("s1", "Sail past the Sirens", "typed");
    root.stores.chat.getState().startAssistantMessage("s1");
    healing.disconnected();
    healing.connected();
    healing.refreshAfterTurn("s1");
    out.sent.length = 0;
    healing.resyncIfNeeded("s1");
    healing.resyncIfNeeded("s1");
    expect(out.sent).toEqual([{ type: "session_resume", sessionId: "s1" }]);
  });
});

describe("restoration driver", () => {
  test("asks once per socket, and again on the next socket", () => {
    const root = makeRoot();
    const sockets: ClientMessage[] = [];
    let send: (message: ClientMessage) => boolean = () => false;
    const driver = createRestorationDriver(root, { send: (message) => send(message), disposed: () => false });
    send = (message) => message.type === "session_resume" ? driver.resume(message, (m) => { sockets.push(m); return true; }) : false;
    const stop = driver.start();
    restores.push(stop, driver.dispose);
    root.stores.connection.getState().setWsStatus("connected");
    root.stores.chat.getState().setActiveSession("s1");
    expect(sockets).toEqual([{ type: "session_resume", sessionId: "s1" }]);
    // Opening the session asks for it as well: one request answers both.
    expect(send({ type: "session_resume", sessionId: "s1" })).toBe(true);
    expect(sockets).toHaveLength(1);
    root.stores.connection.getState().setWsStatus("disconnected");
    root.stores.connection.getState().setWsStatus("connected");
    expect(sockets).toEqual([{ type: "session_resume", sessionId: "s1" }, { type: "session_resume", sessionId: "s1" }]);
    // History arrived: the session is no longer restoring, and nothing more is asked.
    root.stores.chat.getState().setMessages("s1", []);
    root.stores.connection.getState().setWsStatus("disconnected");
    root.stores.connection.getState().setWsStatus("connected");
    expect(sockets).toHaveLength(2);
  });
});

describe("outbound queue", () => {
  function outbound(root: BrainUiRoot, owner?: string) {
    const socket = recorder();
    const resumes: ClientMessage[] = [];
    const dialogues: string[] = [];
    const send = createOutbound(root, {
      socket: () => socket,
      historyOwnerFor: (sessionId) => sessionId === owner ? "voice-1" : undefined,
      loadDialogue: (sessionId) => dialogues.push(sessionId),
      restoration: { resume: (message, socketSend) => { resumes.push(message); return socketSend(message); } },
    });
    return { send, socket: socket.sent, resumes, dialogues };
  }

  test("refuses before the socket is connected, then lets frames leave in order", () => {
    const root = makeRoot();
    const out = outbound(root);
    expect(out.send({ type: "inbox_subscribe", view: "queue" })).toBe(false);
    root.stores.connection.getState().setWsStatus("connected");
    expect(out.send({ type: "inbox_subscribe", view: "queue" })).toBe(true);
    expect(out.send({ type: "inbox_subscribe", view: "actions" })).toBe(true);
    expect(out.socket).toEqual([{ type: "inbox_subscribe", view: "queue" }, { type: "inbox_subscribe", view: "actions" }]);
  });

  test("nothing is sent into a session still restoring, but its history may be asked for", () => {
    const root = makeRoot();
    const out = outbound(root);
    root.stores.connection.getState().setWsStatus("connected");
    root.stores.chat.getState().setActiveSession("s1");
    expect(out.send({ type: "chat_message", sessionId: "s1", text: "Bind me to the mast" } as ClientMessage)).toBe(false);
    expect(out.send({ type: "retry_turn", sessionId: "s1", failedTurnId: "t1", requestId: "r1" })).toBe(false);
    expect(out.send({ type: "session_resume", sessionId: "s1" })).toBe(true);
    expect(out.resumes).toEqual([{ type: "session_resume", sessionId: "s1" }]);
    expect(out.socket).toEqual([{ type: "session_resume", sessionId: "s1" }]);
  });

  test("a voice-owned session is read from its dialogue and written through its owner", () => {
    const root = makeRoot();
    const out = outbound(root, "s1");
    root.stores.connection.getState().setWsStatus("connected");
    root.stores.chat.getState().setActiveSession("s1");
    root.stores.chat.getState().setMessages("s1", []);
    expect(out.send({ type: "session_resume", sessionId: "s1" })).toBe(true);
    expect(out.dialogues).toEqual(["s1"]);
    expect(out.resumes).toEqual([]);
    out.send({ type: "chat_message", sessionId: "s1", text: "Steer for Ithaca" } as ClientMessage);
    expect(out.socket).toEqual([{ type: "chat_message", sessionId: undefined, historyOwnerId: "voice-1", text: "Steer for Ithaca" } as ClientMessage]);
  });

  test("a locked account sends nothing", () => {
    const root = makeRoot();
    const out = outbound(root);
    root.stores.connection.getState().setWsStatus("connected");
    void root.authLock.expire();
    expect(out.send({ type: "inbox_subscribe", view: "queue" })).toBe(false);
    expect(out.socket).toEqual([]);
  });
});

describe("socket lease", () => {
  function lease() {
    const opened: BrainUiClientOptions[] = [];
    const closed: number[] = [];
    const messages: string[] = [];
    let disposed = false;
    const sockets = createSocketLease({
      url: () => "wss://ithaca-harbour.example/ws",
      disposed: () => disposed,
      active: () => true,
      noteSocketOpen: () => {},
      onMessage: (message) => messages.push(message.type),
      onStatusChange: () => {},
      onClose: () => {},
      onProtocolError: () => {},
      createClient: (options) => {
        const index = opened.push(options) - 1;
        return {
          connect() {}, close() { closed.push(index); }, checkLiveness() {}, setForeground() {}, send: () => true,
        } as unknown as BrainUiClient;
      },
    });
    return { sockets, opened, closed, messages, dispose: () => { disposed = true; } };
  }

  test("one socket serves every lease and closes with the last", () => {
    const { sockets, opened } = lease();
    let lastReleases = 0;
    const first = sockets.acquire(() => { lastReleases++; sockets.close(); });
    const second = sockets.acquire(() => { lastReleases++; sockets.close(); });
    expect(opened).toHaveLength(1);
    first();
    first();
    expect(lastReleases).toBe(0);
    expect(sockets.client()).not.toBeNull();
    second();
    expect(lastReleases).toBe(1);
    expect(sockets.client()).toBeNull();
  });

  test("a closed socket's frames and pinned replies never reach the page", () => {
    const { sockets, opened, messages } = lease();
    sockets.acquire(() => {});
    const hello = { type: "pong" } as ServerMessage;
    opened[0].handlers?.onAny?.(hello);
    const replies: ClientMessage[] = [];
    const client = sockets.client()! as unknown as { send: (message: ClientMessage) => boolean };
    client.send = (message) => { replies.push(message); return true; };
    const reply = sockets.pinned(() => true);
    sockets.close();
    sockets.acquire(() => {});
    opened[0].handlers?.onAny?.(hello);
    reply({ type: "location_error", requestId: "r1", code: 0, message: "gone" });
    expect(messages).toEqual(["pong"]);
    expect(replies).toEqual([]);
    expect(opened).toHaveLength(2);
  });

  test("a disposed root cannot take a lease", () => {
    const { sockets, dispose } = lease();
    dispose();
    expect(() => sockets.acquire(() => {})).toThrow("Cannot connect a disposed UI root");
  });
});

describe("turn retries", () => {
  test("a drop turns a waiting retry unknown, and the next socket asks after it", () => {
    const root = makeRoot();
    const out = recorder();
    const retries = createTurnRetries(root.stores.chat, out.send);
    restores.push(retries.clearTimers);
    root.stores.chat.getState().setTurnRetry("s1", { requestId: "r1", failedTurnId: "t1", state: "waiting" });
    retries.disconnected();
    expect(root.stores.chat.getState().turnRetries.s1?.state).toBe("unknown");
    retries.connected();
    expect(out.sent).toEqual([{ type: "retry_status", sessionId: "s1", requestId: "r1" }]);
  });
});

describe("the handler map is the single routing table", () => {
  function context(calls: string[]): DispatchContext {
    return {
      retryReceipt: (msg) => calls.push(`retry:${msg.requestId}`),
      answerReceipt: (msg) => calls.push(`answer:${msg.type}`),
      queueReport: (msg) => calls.push(`queue:${msg.sessionId}`),
    } as Partial<DispatchContext> as DispatchContext;
  }

  test("each frame the connection owns is handled by its own map entry", () => {
    const calls: string[] = [];
    dispatchServerMessage({ type: "retry_receipt", sessionId: "s1", requestId: "r1", state: "unknown" } as ServerMessage, context(calls));
    dispatchServerMessage({ type: "ask_answer_receipt", answerId: "a1", state: "accepted" } as unknown as ServerMessage, context(calls));
    dispatchServerMessage({ type: "session_queue", sessionId: "s1", followUps: [] } as unknown as ServerMessage, context(calls));
    expect(calls).toEqual(["retry:r1", "answer:ask_answer_receipt", "queue:s1"]);
  });

  test("a retry receipt reaches the turn retry through the map", () => {
    const root = makeRoot();
    root.stores.chat.getState().setTurnRetry("s1", { requestId: "r1", failedTurnId: "t1", state: "waiting" });
    root.connection.handleServerMessage({ type: "retry_receipt", sessionId: "s1", requestId: "r1", state: "refused", message: "Scylla blocks the strait." } as ServerMessage);
    expect(root.stores.chat.getState().turnRetries.s1).toMatchObject({ state: "refused", message: "Scylla blocks the strait." });
  });

  test("a queue report reaches the follow-ups through the map", () => {
    const root = makeRoot();
    root.stores.chat.getState().setActiveSession("s1");
    root.stores.chat.getState().setMessages("s1", []);
    root.stores.chat.getState().addUserMessage("s1", "Then row for Ithaca", "typed", undefined, { requestId: "r2" });
    root.connection.handleServerMessage({ type: "session_queue", sessionId: "s1", followUps: [{ requestId: "r2", text: "Then row for Ithaca", source: "typed", queuedAt: 1 }] } as unknown as ServerMessage);
    expect(root.stores.chat.getState().buffers.s1?.messages.some((m) => m.requestId === "r2")).toBe(false);
    expect(root.stores.followUp.getState().pending.s1?.map((entry) => entry.requestId)).toEqual(["r2"]);
  });
});

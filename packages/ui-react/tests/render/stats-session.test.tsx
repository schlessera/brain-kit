// A /stats answer is part of its session (#582): kept with a draft until the
// first message starts a session, sent to the host in an existing one, drawn
// again from replayed history, and marked on screen when it is not kept.
// The root talks to a fake socket, so what is asserted is the frames this
// client actually sent and the store they left behind.
import { unregisterStatsSessionDom } from "./stats-session-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { ClientMessage, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { runStats } from "../../src/components/chat/use-chat-commands.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import type { ChatMessage } from "../../src/stores/chat-state.js";
import { corpusStats, runtimeStats } from "../stats-fixtures.js";
import type { LocalWork } from "../../src/lib/local-work.js";

afterEach(cleanup);
afterAll(unregisterStatsSessionDom);

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url = "") {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

function statsRoot(): BrainUiRoot {
  const root = createBrainUiRoot({ storage: null });
  Object.assign(root.api, {
    brainStats: async () => corpusStats(),
    activityStats: async () => runtimeStats(),
    status: async () => {
      throw new Error("offline");
    },
  });
  return root;
}

function connected(root: BrainUiRoot): FakeSocket {
  root.connection.connect();
  const socket = FakeSocket.instances.at(-1)!;
  act(() => socket.open());
  return socket;
}

function sentFrames(socket: FakeSocket): ClientMessage[] {
  return socket.sent.map((raw) => JSON.parse(raw) as ClientMessage);
}

function draw(root: BrainUiRoot, message: ChatMessage) {
  return render(
    <BrainUiProvider root={root}>
      <MessageBubble message={message} onToolApproval={() => {}} onAskUserSubmit={() => {}} onAskUserCancel={() => {}} onAskUserListSubmit={() => {}} />
    </BrainUiProvider>
  ).container;
}

test("an outside connection lease reconnects after warm auth restoration",async()=>{
 const root=statsRoot();
 try {
  root.localWork={snapshotNow:async()=>{},lock(){},resume:async()=>true,dispose(){}} as LocalWork;
  root.stores.connection.getState().setVpnStatus("connected","odysseus-key");
  const release=root.connection.connect(); const first=FakeSocket.instances.at(-1)!; first.open();
  const count=FakeSocket.instances.length;
  await root.authLock.expire(); root.authLock.dropContext();
  expect(first.readyState,"the outside owner's old socket is closed").toBe(3);
  expect(await root.authLock.signedIn("odysseus-key")).toBe(true); await Promise.resolve();
  expect(FakeSocket.instances.length,"surviving connection owner gets a replacement socket").toBe(count+1);
  const second=FakeSocket.instances.at(-1)!; expect(second).not.toBe(first); second.open();
  expect(root.stores.connection.getState().wsStatus).toBe("connected");
  release(); expect(second.readyState,"one release still closes the one outside lease").toBe(3);
 } finally {root.dispose();}
});

test("a stats operation spanning lock and restore cannot publish old figures or finish the new reply",async()=>{
 const root=statsRoot(); let release!:()=>void;
 const gate=new Promise<void>(yes=>release=yes); let corpusRead=false;
 Object.assign(root.api,{brainStats:async()=>{corpusRead=true;return corpusStats();},brainStatsHistory:async()=>({dates:[]}),status:async()=>{await gate;throw new Error("old read interrupted");}});
 try {
  root.localWork={snapshotNow:async()=>{},lock(){},resume:async()=>true,dispose(){}} as LocalWork;
  root.stores.connection.getState().setVpnStatus("connected","odysseus-key");
  root.stores.chat.getState().setActiveSession("odysseus-ithaca");
  const pending=runStats(root,"odysseus-ithaca"); await Promise.resolve();
  expect(corpusRead,"the old corpus figures already arrived").toBe(true);
  await root.authLock.expire(); root.authLock.dropContext(); expect(await root.authLock.signedIn("odysseus-key")).toBe(true);
  const chat=root.stores.chat.getState(); chat.setActiveSession("odysseus-ithaca"); chat.startAssistantMessage("odysseus-ithaca"); chat.appendText("odysseus-ithaca","Nestor counts the ships");
  release(); await pending;
  const reply=root.stores.chat.getState().buffers["odysseus-ithaca"]!.messages.at(-1)!;
  expect(reply.statsAnswer,"old composite stats cannot publish after warm restore").toBeUndefined();
  expect(reply.localExchange).toBeUndefined(); expect(reply.content).toBe("Nestor counts the ships");
  expect(root.stores.chat.getState().buffers["odysseus-ithaca"]!.isStreaming,"old finally cannot finish the new reply").toBe(true);
 } finally {release();root.dispose();}
});

describe("/stats in a draft conversation", () => {
  test("the first message takes it along, and the session holds both", async () => {
    const root = statsRoot();
    try {
      const socket = connected(root);
      await runStats(root, null);
      const answered = root.stores.chat.getState().draft!.messages.at(-1)!;
      expect(answered.localExchange?.saved).toBe("draft");
      // Nothing is sent for a draft: it has no session to be kept in yet.
      expect(sentFrames(socket).some((frame) => frame.type === "local_exchange")).toBe(false);

      const chat = root.stores.chat.getState();
      chat.addUserMessage(null, "Why so many orphans?", "typed");
      chat.startAssistantMessage(null);
      const draftId = chat.startDraftTurn();
      expect(root.connection.send({ type: "chat_message", text: "Why so many orphans?", draftId })).toBe(true);

      const message = sentFrames(socket).find((frame) => frame.type === "chat_message");
      if (message?.type !== "chat_message") throw new Error("no chat_message sent");
      expect(message.localExchanges).toHaveLength(1);
      const [exchange] = message.localExchanges!;
      expect(exchange).toMatchObject({ id: answered.localExchange!.id, command: "stats", prompt: "Stats" });
      // The agent gets the figures the reader was shown, as text.
      expect(exchange!.context).toContain("3,118");
      expect(exchange!.answer).toEqual(answered.statsAnswer);

      act(() => {
        socket.deliver({ type: "session_info", sessionId: "s1", isNew: true, draftId });
        socket.deliver({ type: "local_exchange_result", sessionId: "s1", exchangeId: exchange!.id, saved: true });
      });
      const session = root.stores.chat.getState().buffers.s1!;
      expect(session.messages.map((m) => [m.role, m.content])).toEqual([
        ["user", "Stats"],
        ["assistant", ""],
        ["user", "Why so many orphans?"],
        ["assistant", ""],
      ]);
      expect(session.messages[1]!.localExchange?.saved).toBe("saved");
      expect(session.messages[1]!.statsAnswer?.length).toBeGreaterThan(0);
      // A result frame says nothing about run state.
      expect(root.stores.chat.getState().runStates.s1).toBe("streaming");
    } finally {
      root.dispose();
    }
  });
});

describe("/stats in an existing session", () => {
  test("is sent to the host, and kept once the host says so", async () => {
    const root = statsRoot();
    try {
      const socket = connected(root);
      root.stores.chat.getState().setActiveSession("s1");
      // Its history is here: nothing is recorded into a session still restoring (#1328).
      act(() => { socket.deliver({ type: "session_history", sessionId: "s1", messages: [] }); socket.deliver({ type: "status", sessionId: "s1", status: "idle" }); });
      await runStats(root, "s1");
      const frame = sentFrames(socket).find((f) => f.type === "local_exchange");
      if (frame?.type !== "local_exchange") throw new Error("no local_exchange sent");
      expect(frame.sessionId).toBe("s1");
      expect(frame.exchange.context).toContain("3,118");
      expect(root.stores.chat.getState().buffers.s1!.messages.at(-1)!.localExchange?.saved).toBe("pending");

      act(() => socket.deliver({ type: "local_exchange_result", sessionId: "s1", exchangeId: frame.exchange.id, saved: true }));
      const message = root.stores.chat.getState().buffers.s1!.messages.at(-1)!;
      expect(message.localExchange?.saved).toBe("saved");
      expect(draw(root, message).querySelector("[data-local-exchange-unsaved]")).toBeNull();
      // A result frame must not mark the session as running.
      expect(root.stores.chat.getState().runStates.s1).toBeUndefined();
    } finally {
      root.dispose();
    }
  });

  test("with the socket down it still answers, and says it was not saved", async () => {
    const root = statsRoot();
    try {
      root.stores.chat.getState().setActiveSession("s1");
      await runStats(root, "s1");
      const message = root.stores.chat.getState().buffers.s1!.messages.at(-1)!;
      expect(message.statsAnswer?.length).toBeGreaterThan(0);
      expect(message.localExchange?.saved).toBe("unsaved");
      const note = draw(root, message).querySelector("[data-local-exchange-unsaved]");
      expect(note?.textContent).toContain("Not saved to this conversation.");
      expect(note?.textContent).toContain("There is no connection to the server.");
    } finally {
      root.dispose();
    }
  });

  test("a host that did not keep it is shown as not saved, with its reason", async () => {
    const root = statsRoot();
    try {
      const socket = connected(root);
      root.stores.chat.getState().setActiveSession("s1");
      // Its history is here: nothing is recorded into a session still restoring (#1328).
      act(() => { socket.deliver({ type: "session_history", sessionId: "s1", messages: [] }); socket.deliver({ type: "status", sessionId: "s1", status: "idle" }); });
      await runStats(root, "s1");
      const frame = sentFrames(socket).find((f) => f.type === "local_exchange");
      if (frame?.type !== "local_exchange") throw new Error("no local_exchange sent");
      act(() =>
        socket.deliver({
          type: "local_exchange_result",
          sessionId: "s1",
          exchangeId: frame.exchange.id,
          saved: false,
          reason: "The server could not store it.",
        })
      );
      const message = root.stores.chat.getState().buffers.s1!.messages.at(-1)!;
      const note = draw(root, message).querySelector("[data-local-exchange-unsaved]");
      expect(note?.textContent).toContain("The server could not store it.");
    } finally {
      root.dispose();
    }
  });
});

describe("a replayed /stats exchange", () => {
  test("is drawn with the kit, where the history puts it", async () => {
    const root = statsRoot();
    try {
      const socket = connected(root);
      root.stores.chat.getState().setActiveSession("s1");
      // Its history is here: nothing is recorded into a session still restoring (#1328).
      act(() => { socket.deliver({ type: "session_history", sessionId: "s1", messages: [] }); socket.deliver({ type: "status", sessionId: "s1", status: "idle" }); });
      await runStats(root, "s1");
      const live = root.stores.chat.getState().buffers.s1!.messages.at(-1)!;
      const messages: SessionHistoryMessage[] = [
        { role: "user", content: "Stats", toolCalls: [] },
        {
          role: "assistant",
          content: "",
          toolCalls: [],
          localAnswer: { exchangeId: "x1", command: "stats", answer: live.statsAnswer },
        },
        { role: "user", content: "Which is worst?", toolCalls: [] },
        { role: "assistant", content: "Orphans.", toolCalls: [] },
      ];
      act(() => socket.deliver({ type: "session_history", sessionId: "s1", messages }));

      const replayed = root.stores.chat.getState().buffers.s1!.messages;
      expect(replayed.map((m) => m.content)).toEqual(["Stats", "", "Which is worst?", "Orphans."]);
      expect(replayed[1]!.statsAnswer).toEqual(live.statsAnswer);
      expect(replayed[1]!.localExchange?.saved).toBe("saved");
      const drawn = draw(root, replayed[1]!);
      const kinds = [...drawn.querySelectorAll("[data-stats-section]")].map((el) => el.getAttribute("data-stats-section"));
      expect(kinds).toEqual(live.statsAnswer!.map((section) => section.kind));
      expect(kinds.length).toBeGreaterThan(0);
    } finally {
      root.dispose();
    }
  });

  test("an answer this build cannot read replays as an empty message, not a crash", async () => {
    const root = statsRoot();
    try {
      const socket = connected(root);
      root.stores.chat.getState().setActiveSession("s1");
      act(() =>
        socket.deliver({
          type: "session_history",
          sessionId: "s1",
          messages: [
            { role: "assistant", content: "", toolCalls: [], localAnswer: { exchangeId: "x1", command: "stats", answer: "nope" } },
            {
              role: "assistant",
              content: "",
              toolCalls: [],
              localAnswer: { exchangeId: "x2", command: "stats", answer: [{ kind: "tiles" }, { kind: "unknown" }] },
            },
          ],
        })
      );
      const [unreadable, partial] = root.stores.chat.getState().buffers.s1!.messages;
      expect(unreadable!.statsAnswer).toBeUndefined();
      expect(partial!.statsAnswer).toEqual([]);
    } finally {
      root.dispose();
    }
  });
});

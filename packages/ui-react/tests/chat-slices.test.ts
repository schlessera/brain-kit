/**
 * Direct tests of the chat store's slices (#1361). Each slice runs over a
 * bare store holding only the shared buffer fields, so a slice that reached
 * into another slice's state would fail here before it failed in the
 * composed store.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { MessageLink, TurnFailure, TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";
import { createChatStore, type ChatMessage, type ChatState, type SessionChat } from "../src/stores/chat-state";
import { createApprovalsSlice } from "../src/stores/chat-slices/approvals";
import { createAskUserSlice, isSettledExchange } from "../src/stores/chat-slices/ask-user";
import { createChatSliceContext, emptyChat, evictStale, revokeAttachmentUrls, type ChatSliceContext } from "../src/stores/chat-slices/buffers";
import { createMessagesSlice } from "../src/stores/chat-slices/messages";
import { createChatPersistence } from "../src/stores/chat-slices/persistence";
import { createSessionSlice } from "../src/stores/chat-slices/session";
import { createStatusSlice } from "../src/stores/chat-slices/status";
import { createStreamingSlice } from "../src/stores/chat-slices/streaming";
import { createTranscriptSlice } from "../src/stores/chat-slices/transcript";
import type { ProviderState } from "../src/stores/provider-state";
import type { StoreEnvironment } from "../src/stores/store-environment";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function environment(storage: Storage | null = memoryStorage()): StoreEnvironment {
  return { storage: () => storage, storageKey: (key: string) => `odysseus:${key}` } as unknown as StoreEnvironment;
}

/** A bare store: the shared buffer fields plus exactly one slice. */
function sliceStore<S extends object>(slice: (ctx: ChatSliceContext) => S, base: Partial<ChatState> = {}): StoreApi<ChatState & S> {
  return createStore<ChatState & S>((set, get) => ({
    buffers: {}, draft: null, activeSessionId: null, restoreFailures: {}, detachedDrafts: {}, pendingDraftId: null,
    ...base,
    ...slice(createChatSliceContext(set, get)),
  }) as unknown as ChatState & S);
}

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return { content: "", toolCalls: [], parts: [], isStreaming: false, timestamp: 0, ...overrides };
}

function buffer(messages: ChatMessage[], extra: Partial<SessionChat> = {}): SessionChat {
  return { ...emptyChat(), messages, ...extra };
}

function provider() {
  const setPinned = mock((pinned: unknown) => void pinned);
  return { setPinned, store: createStore(() => ({ setPinned })) as unknown as StoreApi<ProviderState> };
}

describe("buffers", () => {
  const revoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")!;
  afterEach(() => { Object.defineProperty(URL, "revokeObjectURL", revoke); });

  test("a session mutation needs an existing buffer; the draft and createIfMissing make one", () => {
    const store = sliceStore((ctx) => ({ ctx }));
    const { ctx } = store.getState();
    ctx.mutateBuffer("ithaca", () => ({ isStreaming: true }));
    expect(store.getState().buffers).toEqual({});
    ctx.mutateBuffer("ithaca", () => ({ isStreaming: true }), true);
    expect(store.getState().buffers.ithaca?.isStreaming).toBe(true);
    ctx.mutateBuffer(null, () => ({ isStreaming: true }));
    expect(store.getState().draft?.isStreaming).toBe(true);
  });

  test("a turn's journal receipt lands on that turn's last assistant message only", () => {
    const journal = { turnId: "t1" } as unknown as TurnJournalSummary;
    const store = sliceStore((ctx) => ({ ctx }), { buffers: { ithaca: buffer([
      message({ id: "a1", role: "assistant", turnId: "t1" }),
      message({ id: "a2", role: "assistant", turnId: "t1" }),
      message({ id: "a3", role: "assistant", turnId: "t2" }),
    ]) } });
    store.getState().ctx.mutateBuffer("ithaca", () => ({ journals: { t1: journal } }));
    const messages = store.getState().buffers.ithaca!.messages;
    expect(messages.map((m) => m.journal ?? null)).toEqual([null, journal, null]);
    expect(messages[1]!.journalLive).toBe(true);
  });

  test("the last-assistant mutator skips a follow-up user message; the holder mutator finds the tool's message", () => {
    const store = sliceStore((ctx) => ({ ctx }), { buffers: { ithaca: buffer([
      message({ id: "a1", role: "assistant", toolCalls: [{ id: "tool-1", name: "Read", input: {}, inputJson: "", status: "pending_approval" }] }),
      message({ id: "a2", role: "assistant" }),
      message({ id: "u1", role: "user" }),
    ]) } });
    const { ctx } = store.getState();
    ctx.mutateLastAssistant("ithaca", (m) => ({ ...m, content: "last" }), () => ({ isStreaming: true }));
    ctx.mutateToolHolder("ithaca", "tool-1", (m) => ({ ...m, content: "holder" }));
    const chat = store.getState().buffers.ithaca!;
    expect(chat.messages.map((m) => m.content)).toEqual(["holder", "last", ""]);
    expect(chat.isStreaming).toBe(true);
  });

  test("ids are unique within one store", () => {
    const { ctx } = sliceStore((c) => ({ ctx: c })).getState();
    expect(ctx.nextId()).not.toBe(ctx.nextId());
  });

  test("eviction keeps the active and streaming buffers and releases the evicted previews", () => {
    const revoked: string[] = [];
    Object.defineProperty(URL, "revokeObjectURL", { ...revoke, value: (url: string) => void revoked.push(url) });
    const buffers: Record<string, SessionChat> = {};
    for (let i = 0; i < 10; i++) {
      buffers[`s${i}`] = buffer([message({ id: `u${i}`, role: "user", attachments: [{ previewUrl: `blob:s${i}` } as never] })], { lastTouched: i, isStreaming: i === 1 });
    }
    const kept = evictStale(buffers, "s0");
    expect(Object.keys(kept).sort()).toEqual(["s0", "s1", "s4", "s5", "s6", "s7", "s8", "s9"]);
    expect(revoked).toEqual(["blob:s2", "blob:s3"]);
  });

  test("a retained preview and a non-blob preview are never revoked", () => {
    const revoked: string[] = [];
    Object.defineProperty(URL, "revokeObjectURL", { ...revoke, value: (url: string) => void revoked.push(url) });
    const shown = message({ id: "u1", role: "user", attachments: [{ previewUrl: "blob:kept" }, { previewUrl: "blob:gone" }, { previewUrl: "data:x" }] as never });
    revokeAttachmentUrls([shown], [message({ id: "u1", role: "user", attachments: [{ previewUrl: "blob:kept" }] as never })]);
    expect(revoked).toEqual(["blob:gone"]);
  });
});

describe("persistence", () => {
  test("a history selection outranks the plain session id and clears it", () => {
    const storage = memoryStorage();
    const persistence = createChatPersistence(environment(storage));
    persistence.persistSessionId("ithaca");
    expect(persistence.readPersistedSessionId()).toBe("ithaca");
    persistence.persistSessionId("troy", "penelope");
    expect(persistence.readHistorySelection()).toEqual({ key: "troy", ownerId: "penelope" });
    expect(storage.getItem("odysseus:brain-sessionId")).toBeNull();
    expect(persistence.readPersistedSessionId()).toBe("troy");
    persistence.persistSessionId(null);
    expect(persistence.readPersistedSessionId()).toBeNull();
  });

  test("a corrupt selection grants nothing, and no storage reads as empty", () => {
    const storage = memoryStorage();
    storage.setItem("odysseus:brain-history-selection", "{not json");
    expect(createChatPersistence(environment(storage)).readHistorySelection()).toBeNull();
    const none = createChatPersistence(environment(null));
    expect(none.readPersistedSessionId()).toBeNull();
    expect(none.readRetries()).toEqual({});
    expect(none.readStateRoomPreferences()).toEqual({});
  });

  test("retries persist without refused ones and read back as unknown", () => {
    const storage = memoryStorage();
    const persistence = createChatPersistence(environment(storage));
    persistence.persistRetries({
      ithaca: { requestId: "r1", failedTurnId: "t1", state: "waiting" },
      troy: { requestId: "r2", failedTurnId: "t2", state: "refused" },
    });
    expect(Object.keys(JSON.parse(storage.getItem("odysseus:brain-turn-retries")!))).toEqual(["ithaca"]);
    expect(persistence.readRetries()).toEqual({ ithaca: { requestId: "r1", failedTurnId: "t1", state: "unknown" } });
  });

  test("state-room preferences keep only valid fields", () => {
    const storage = memoryStorage();
    storage.setItem("odysseus:brain-state-room-preferences", JSON.stringify({
      ithaca: { dismissedAllowance: 4096, invalidatedAt: -1, backendId: "claude", measuredAt: 7 },
      troy: "nope",
    }));
    expect(createChatPersistence(environment(storage)).readStateRoomPreferences()).toEqual({
      ithaca: { dismissedAllowance: 4096, backendId: "claude", measuredAt: 7 },
    });
  });
});

describe("messages slice", () => {
  test("a user send creates the buffer it lands in", () => {
    const store = sliceStore(createMessagesSlice);
    store.getState().addUserMessage("ithaca", "Which way to Ithaca?", undefined, [{ previewUrl: "blob:map" } as never]);
    const [sent] = store.getState().buffers.ithaca!.messages;
    expect(sent).toMatchObject({ role: "user", content: "Which way to Ithaca?", source: "typed", attachmentCount: 1 });
  });

  test("streamed text and thinking merge into chronological parts", () => {
    const store = sliceStore(createMessagesSlice, { buffers: { ithaca: emptyChat() } });
    const s = store.getState();
    s.startAssistantMessage("ithaca", "t1", "r1");
    s.appendThinking("ithaca", "Sail ");
    s.appendText("ithaca", "West");
    s.appendText("ithaca", " by night");
    const [answer] = store.getState().buffers.ithaca!.messages;
    expect(answer).toMatchObject({ turnId: "t1", requestId: "r1", isStreaming: true, content: "West by night", thinking: "Sail " });
    expect(answer!.parts).toEqual([{ kind: "thinking", text: "Sail " }, { kind: "text", text: "West by night" }]);
    expect(store.getState().buffers.ithaca!.isStreaming).toBe(true);
  });

  test("a tool call streams, completes and takes its result", () => {
    const store = sliceStore(createMessagesSlice, { buffers: { ithaca: emptyChat() } });
    const s = store.getState();
    s.startAssistantMessage("ithaca");
    s.startToolCall("ithaca", "tool-1", "Read");
    s.appendToolInput("ithaca", '{"path":');
    s.appendToolInput("ithaca", '"log.md"}');
    s.completeToolCall("ithaca", "tool-1", "Read", { path: "log.md" });
    s.setToolResult("ithaca", "tool-1", "the log", false);
    const [tool] = store.getState().buffers.ithaca!.messages[0]!.toolCalls;
    expect(tool).toMatchObject({ id: "tool-1", inputJson: '{"path":"log.md"}', input: { path: "log.md" }, output: "the log", status: "complete" });
  });

  test("a local exchange is marked wherever it is", () => {
    const store = sliceStore(createMessagesSlice, { buffers: { ithaca: buffer([message({ id: "a1", role: "assistant" })]) } });
    store.getState().setLocalExchange("ithaca", { id: "x1", saved: "draft", reason: "offline" } as never);
    store.getState().markLocalExchange("x1", "saved" as never);
    expect(store.getState().buffers.ithaca!.messages[0]!.localExchange).toEqual({ id: "x1", saved: "saved" } as never);
  });
});

describe("streaming slice", () => {
  test("finishing ends the message's and the buffer's stream", () => {
    const store = sliceStore(createStreamingSlice, { buffers: { ithaca: buffer([message({ id: "a1", role: "assistant", isStreaming: true })], { isStreaming: true }) } });
    store.getState().finishAssistantMessage("ithaca");
    expect(store.getState().buffers.ithaca!.isStreaming).toBe(false);
    expect(store.getState().buffers.ithaca!.messages[0]!.isStreaming).toBe(false);
  });

  test("a failure no message owns draws its own message for the turn", () => {
    const failure = { code: "overloaded" } as unknown as TurnFailure;
    const store = sliceStore(createStreamingSlice, { buffers: { ithaca: buffer([message({ id: "a1", role: "assistant", turnId: "t0" })]) } });
    store.getState().failAssistantMessage("ithaca", failure, "t1");
    const messages = store.getState().buffers.ithaca!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ turnId: "t1", failure, failureLive: true, isStreaming: false });
  });

  test("blocks without a turn wait for the streaming follow-up to finish", () => {
    const store = sliceStore(createStreamingSlice, { buffers: { ithaca: buffer([message({ id: "a1", role: "assistant", isStreaming: true })]) } });
    store.getState().setMessageBlocks("ithaca", [{ kind: "x" } as never]);
    expect(store.getState().buffers.ithaca!.messages[0]!.blocks).toBeUndefined();
  });

  test("promoted links rewrite the turn's text and content", () => {
    const store = sliceStore(createStreamingSlice, { buffers: { ithaca: buffer([message({
      id: "a1", role: "assistant", turnId: "t1", content: "See [log](inbox/log.md)", parts: [{ kind: "text", text: "See [log](inbox/log.md)" }],
    })]) } });
    store.getState().rewriteMessageLinks("ithaca", [{ from: "inbox/log.md", to: "voyage/log.md" } as MessageLink], "t1");
    expect(store.getState().buffers.ithaca!.messages[0]!.content).toBe("See [log](voyage/log.md)");
  });

  test("the turn is stamped once on the streaming message", () => {
    const store = sliceStore(createStreamingSlice, { buffers: { ithaca: buffer([message({ id: "a1", role: "assistant", isStreaming: true })]) } });
    store.getState().stampTurn("ithaca", "t1");
    store.getState().stampTurn("ithaca", "t2");
    expect(store.getState().buffers.ithaca!.messages[0]!.turnId).toBe("t1");
  });
});

describe("approvals slice", () => {
  test("a request on a replay that ended on the user's message draws a turn shell, once", () => {
    const store = sliceStore(createApprovalsSlice, { buffers: { ithaca: buffer([message({ id: "u1", role: "user" })]) } });
    store.getState().requestToolApproval("ithaca", "tool-1", "Bash", { command: "ls" }, undefined, undefined, undefined, "t1");
    store.getState().requestToolApproval("ithaca", "tool-1", "Bash", { command: "ls" }, undefined, undefined, undefined, "t1");
    const messages = store.getState().buffers.ithaca!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ turnShell: true, turnId: "t1" });
    expect(messages[1]!.toolCalls).toHaveLength(1);
    expect(messages[1]!.toolCalls[0]).toMatchObject({ status: "pending_approval", restored: true, approvalTurnId: "t1" });
  });

  test("a decision reaches the card, and a restored card closes, reopens and is revoked", () => {
    const store = sliceStore(createApprovalsSlice, { buffers: { ithaca: buffer([message({ id: "u1", role: "user" })]) } });
    const s = store.getState();
    s.requestToolApproval("ithaca", "tool-1", "Bash", {});
    s.requestToolApproval("ithaca", "tool-2", "Bash", {});
    s.resolveToolApproval("ithaca", "tool-1", true);
    const tools = () => store.getState().buffers.ithaca!.messages.flatMap((m) => m.toolCalls);
    expect(tools()[0]!.status).toBe("approved");
    s.closeRestoredApprovals("ithaca", [{ toolUseId: "tool-1", closure: "ended" }, { toolUseId: "tool-2", closure: "unlisted" }]);
    expect(tools().map((t) => t.readOnly ?? null)).toEqual([null, "unlisted"]);
    s.reopenRestoredApprovals("ithaca", ["tool-2"]);
    expect(tools()[1]!.readOnly).toBeUndefined();
    s.revokeRestoredApprovals();
    expect(tools().map((t) => t.readOnly)).toEqual(["revoked", "revoked"]);
    expect(tools()[1]!.id).toMatch(/^revoked-/);
  });
});

describe("ask-user slice", () => {
  const question = [{ question: "Which island?", header: "Island", options: [], multiSelect: false }] as never;

  test("a re-delivered request updates its card instead of drawing another", () => {
    const store = sliceStore(createAskUserSlice, { buffers: { ithaca: buffer([message({ id: "a1", role: "assistant", isStreaming: true })]) } });
    store.getState().setAskUserRequest("ithaca", "q1", question);
    store.getState().setAskUserRequest("ithaca", "q1", question, "t1");
    const chat = store.getState().buffers.ithaca!;
    expect(chat.messages[0]!.askUserExchanges).toHaveLength(1);
    expect(chat.askUser).toMatchObject({ requestId: "q1", turnId: "t1" });
  });

  test("an answer settles the card, a late request leaves it settled, and reopening clears the answer", () => {
    const store = sliceStore(createAskUserSlice, { buffers: { ithaca: buffer([message({ id: "a1", role: "assistant" })]) } });
    const s = store.getState();
    s.setAskUserRequest("ithaca", "q1", question);
    s.submitAskUserAnswers("ithaca", "q1", { Island: "Ithaca" });
    s.setAskUserRequest("ithaca", "q1", question);
    const exchange = () => store.getState().buffers.ithaca!.messages[0]!.askUserExchanges![0]!;
    expect(isSettledExchange(exchange())).toBe(true);
    s.reopenAskExchange("ithaca", "q1");
    expect(isSettledExchange(exchange())).toBe(false);
    expect(store.getState().buffers.ithaca!.askUser?.requestId).toBe("q1");
  });

  test("a turn's end closes only its unanswered questions", () => {
    const store = sliceStore(createAskUserSlice, { buffers: { ithaca: buffer([message({ id: "a1", role: "assistant" })]) } });
    store.getState().setAskUserRequest("ithaca", "q1", question, "t1");
    store.getState().setAskUserRequest("ithaca", "q2", question, "t2");
    store.getState().endTurnQuestions("ithaca", "t1");
    expect(store.getState().buffers.ithaca!.messages[0]!.askUserExchanges!.map((e) => e.terminal ?? false)).toEqual([true, false]);
  });

  test("deliveries are held per request outside the buffers", () => {
    const store = sliceStore(createAskUserSlice);
    store.getState().setDelivery("q1", { state: "queued" } as never);
    expect(store.getState().deliveries).toEqual({ q1: { state: "queued" } } as never);
    store.getState().setDelivery("q1", null);
    expect(store.getState().deliveries).toEqual({});
  });
});

describe("transcript slice", () => {
  test("history confirms the buffer and ends its restore failure", () => {
    const store = sliceStore(createTranscriptSlice, { restoreFailures: { ithaca: { reason: "timeout" } } });
    store.getState().setMessages("ithaca", [message({ id: "u1", role: "user", content: "Hello" })]);
    expect(store.getState().buffers.ithaca).toMatchObject({ historyConfirmed: true, messages: [{ id: "u1" }] });
    expect(store.getState().restoreFailures).toEqual({});
  });

  test("a chunked replay keeps the live answer the first chunk held back", () => {
    const live = message({ id: "a1", role: "assistant", content: "Sailing west", parts: [{ kind: "text", text: "Sailing west" }], isStreaming: true, turnId: "t1" });
    const store = sliceStore(createTranscriptSlice, { buffers: { ithaca: buffer([message({ id: "u1", role: "user" }), live], { isStreaming: true }) } });
    store.getState().setMessages("ithaca", [message({ id: "h1", role: "user" })]);
    store.getState().appendMessages("ithaca", [message({ id: "h2", role: "assistant", turnId: "t1", content: "Sailing", parts: [{ kind: "text", text: "Sailing" }] })]);
    store.getState().finishHistoryReplay("ithaca", true);
    const chat = store.getState().buffers.ithaca!;
    expect(chat.replay).toBeUndefined();
    expect(chat.messages.at(-1)!.content).toBe("Sailing west");
  });

  test("history loads are counted per session", () => {
    const store = sliceStore(createTranscriptSlice);
    store.getState().noteHistoryLoaded("ithaca");
    store.getState().noteHistoryLoaded("ithaca");
    expect(store.getState().historyLoads).toEqual({ ithaca: 2 });
  });
});

describe("session slice", () => {
  function sessionStore(storage = memoryStorage()) {
    const pinned = provider();
    const newChat = mock(() => {});
    const drafts = createStore(() => ({ newChat }));
    const persistence = createChatPersistence(environment(storage));
    const store = sliceStore((ctx) => createSessionSlice(ctx, persistence, pinned.store, drafts));
    return { store, storage, setPinned: pinned.setPinned, newChat };
  }

  test("the stored selection is in view, with its owner and an unconfirmed buffer", () => {
    const storage = memoryStorage();
    storage.setItem("odysseus:brain-history-selection", JSON.stringify({ key: "troy", ownerId: "penelope" }));
    const { store } = sessionStore(storage);
    expect(store.getState()).toMatchObject({ activeSessionId: "troy", historyOwners: { troy: "penelope" } });
    // The buffer exists and is empty; only then does its unconfirmed state mean anything.
    expect(store.getState().buffers.troy).toMatchObject({ messages: [], isStreaming: false });
    expect(store.getState().buffers.troy!.historyConfirmed).toBeUndefined();
  });

  test("selecting a session persists it and gives it a buffer", () => {
    const { store, storage } = sessionStore();
    store.getState().setActiveSession("ithaca");
    expect(storage.getItem("odysseus:brain-sessionId")).toBe("ithaca");
    expect(store.getState().buffers.ithaca).toBeDefined();
  });

  test("a new chat sets an unanswered first message aside, unpins the provider and clears the composer", () => {
    const { store, setPinned, newChat } = sessionStore();
    const s = store.getState();
    store.setState({ draft: buffer([message({ id: "u1", role: "user" })]) });
    const correlation = s.startDraftTurn();
    s.clearMessages();
    expect(store.getState()).toMatchObject({ draft: null, activeSessionId: null, pendingDraftId: null });
    expect(store.getState().detachedDrafts[correlation]?.messages).toHaveLength(1);
    expect(setPinned).toHaveBeenCalledWith(null);
    expect(newChat).toHaveBeenCalledTimes(1);
    s.bindDetachedDraft(correlation, "ithaca");
    expect(store.getState().buffers.ithaca).toMatchObject({ historyConfirmed: true, messages: [{ id: "u1" }] });
  });

  test("a bound draft becomes the session in view", () => {
    const { store } = sessionStore();
    store.setState({ draft: buffer([message({ id: "u1", role: "user" })]) });
    store.getState().bindDraftSession("ithaca");
    expect(store.getState()).toMatchObject({ activeSessionId: "ithaca", draft: null, buffers: { ithaca: { historyConfirmed: true } } });
  });

  test("a withdrawn send leaves the transcript", () => {
    const { store } = sessionStore();
    store.setState({ buffers: { ithaca: buffer([message({ id: "u1", role: "user", requestId: "r1" }), message({ id: "a1", role: "assistant", requestId: "r1", isStreaming: true })], { isStreaming: true }) } });
    store.getState().withdrawSend("ithaca", "r1");
    expect(store.getState().buffers.ithaca).toMatchObject({ messages: [], isStreaming: false });
  });

  test("a restore failure is kept until a confirmed buffer outranks it", () => {
    const { store } = sessionStore();
    store.getState().failRestore("ithaca", { reason: "timeout" });
    expect(store.getState().restoreFailures).toEqual({ ithaca: { reason: "timeout" } });
    store.getState().clearRestoreFailure("ithaca");
    expect(store.getState().restoreFailures).toEqual({});
  });
});

describe("status slice", () => {
  function statusStore(storage = memoryStorage()) {
    return { store: sliceStore((ctx) => createStatusSlice(ctx, createChatPersistence(environment(storage)))), storage };
  }

  test("a queue note lives only while the session is queued", () => {
    const { store } = statusStore();
    store.getState().setRunState("ithaca", "queued", "Three ahead");
    expect(store.getState()).toMatchObject({ runStates: { ithaca: "queued" }, queueNotes: { ithaca: "Three ahead" } });
    store.getState().setRunState("ithaca", "idle");
    expect(store.getState()).toMatchObject({ runStates: {}, queueNotes: {} });
  });

  test("an accepted chat receipt is not overwritten", () => {
    const { store } = statusStore();
    store.getState().setChatReceipt("r1", "accepted", "ithaca");
    store.getState().setChatReceipt("r1", "refused");
    expect(store.getState().chatReceipts).toEqual({ r1: { state: "accepted", sessionId: "ithaca" } });
  });

  test("a turn retry is stored and read back by the next store", () => {
    const { store, storage } = statusStore();
    store.getState().setTurnRetry("ithaca", { requestId: "r1", failedTurnId: "t1", state: "waiting" });
    expect(statusStore(storage).store.getState().turnRetries).toEqual({ ithaca: { requestId: "r1", failedTurnId: "t1", state: "unknown" } });
  });

  test("a dismissed state room is remembered against its allowance", () => {
    const { store, storage } = statusStore();
    store.getState().setSessionBackend("ithaca", "claude");
    store.getState().setStateRoom("ithaca", { observedAt: 5, allowanceBytes: 4096 } as never);
    store.getState().dismissStateRoom("ithaca", 4096);
    expect(statusStore(storage).store.getState().stateRoomPreferences).toEqual({ ithaca: { dismissedAllowance: 4096, backendId: "claude", measuredAt: 5 } });
  });

  test("each composer insert is a new request, and only its own seq clears it", () => {
    const { store } = statusStore();
    store.getState().requestComposerInsert("Ask about Ithaca");
    const first = store.getState().composerInsert!.seq;
    store.getState().requestComposerInsert("Ask about Ithaca");
    store.getState().clearComposerInsert(first);
    expect(store.getState().composerInsert).toEqual({ seq: first + 1, text: "Ask about Ithaca" });
  });
});

describe("composition", () => {
  test("the slices own disjoint keys that make up the whole store", () => {
    const ctx = createChatSliceContext(() => {}, () => ({}) as ChatState);
    const persistence = createChatPersistence(environment());
    const slices = {
      status: createStatusSlice(ctx, persistence),
      session: createSessionSlice(ctx, persistence, provider().store),
      messages: createMessagesSlice(ctx),
      approvals: createApprovalsSlice(ctx),
      askUser: createAskUserSlice(ctx),
      streaming: createStreamingSlice(ctx),
      transcript: createTranscriptSlice(ctx),
    };
    const owners = new Map<string, string[]>();
    for (const [name, slice] of Object.entries(slices)) for (const key of Object.keys(slice)) owners.set(key, [...(owners.get(key) ?? []), name]);
    expect([...owners].filter(([, names]) => names.length > 1)).toEqual([]);
    const store = createChatStore(environment(), provider().store);
    expect([...owners.keys()].sort()).toEqual(Object.keys(store.getState()).sort());
  });
});

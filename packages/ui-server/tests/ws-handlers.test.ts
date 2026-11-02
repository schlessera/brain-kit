// Direct tests for each client message handler under src/ws/handlers/ (#1358).
//
// Every handler takes an explicit context, so each one is exercised here
// without a socket, an app or the dispatch closure: a real TurnCoordinator
// holds pending state, and the rest of the host is a recording stub carrying
// only what the handler reads. The runtime suites (ws-*.test.ts) remain the
// behavioural guard through the real dispatch path.

import { describe, expect, test } from "bun:test";
import type { ClientMessage, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "../src/ws/clients";
import type { WsHost } from "../src/ws/host";
import { TurnCoordinator, type PendingApproval, type RunningTurn } from "../src/ws/turns";
import type { ClientMessageOf, ClientMessageType, ConnectionState, HandlerContext } from "../src/ws/handlers/context";
import { CLIENT_MESSAGE_HANDLERS } from "../src/ws/handlers/index";
import { handleActivitySubscribe, handleActivityUnsubscribe } from "../src/ws/handlers/activity";
import { handleAskAnswerFrame, handleAskAnswerStatusFrame, handleAskUserCancel } from "../src/ws/handlers/ask";
import { handleCancel } from "../src/ws/handlers/cancel";
import { handleChatMessageFrame } from "../src/ws/handlers/chat-message";
import { handleClientHello } from "../src/ws/handlers/client-hello";
import {
  handleConversationAudio,
  handleConversationCommit,
  handleConversationEndpoint,
  handleConversationPlayback,
  handleConversationStart,
  handleConversationStop,
} from "../src/ws/handlers/conversation";
import { handleDialogueRead } from "../src/ws/handlers/dialogue-read";
import { handleHandoffPrepare, handleHandoffPrepareCancel, handleHandoffStatus } from "../src/ws/handlers/handoff";
import { handleInboxDecision, handleInboxSubscribe, handleInboxUnsubscribe } from "../src/ws/handlers/inbox";
import { handleLocalExchange } from "../src/ws/handlers/local-exchange";
import { handleLocationError, handleLocationResponse } from "../src/ws/handlers/location";
import { handleMaskError, handleMaskResponse } from "../src/ws/handlers/mask";
import { handlePing } from "../src/ws/handlers/ping";
import { handleRetryStatus, handleRetryTurn } from "../src/ws/handlers/retry";
import { handleScopeDecision } from "../src/ws/handlers/scope-decision";
import { handleSessionResume } from "../src/ws/handlers/session-resume";
import { handleToolApproval, handleToolDenial } from "../src/ws/handlers/tool-permission";
import { testAuthorization, testPrincipal } from "./helpers/principal";

const ws = { id: "socket" } as unknown as WSContext;

interface Harness {
  ctx: HandlerContext;
  coordinator: TurnCoordinator;
  sent: ServerMessage[];
  calls: string[];
}

/** A context whose host is `overrides` over a recording base. */
function harness(
  overrides: Record<string, unknown> = {},
  connection: Partial<ConnectionState> = {},
  requireEcho = false
): Harness {
  const coordinator = new TurnCoordinator();
  const sent: ServerMessage[] = [];
  const calls: string[] = [];
  const host = {
    coordinator,
    catalog: {},
    sendMessage: (_ws: WSContext, msg: ServerMessage) => { sent.push(msg); },
    sendToClients: (msg: ServerMessage) => { sent.push(msg); },
    log: { emit: (record: { body: string }) => { calls.push(`log:${record.body}`); } },
    toolPermissions: null,
    conversations: null,
    inbox: null,
    activity: null,
    closing: false,
    expireAuthorizationContexts: () => {},
    reportDroppedFrame: (reason: string) => { calls.push(`dropped:${reason}`); },
    reportSessionResume: (_id: string, outcome: string) => { calls.push(`resume:${outcome}`); },
    reportTurnFailed: (code: string) => { calls.push(`failed:${code}`); },
    maxConcurrentSessions: () => 3,
    ...overrides,
  } as unknown as WsHost;
  const ctx: HandlerContext = {
    host,
    ws,
    connection: { principal: testPrincipal(), authorization: testAuthorization(), ...connection },
    requireEcho,
  };
  return { ctx, coordinator, sent, calls };
}

function frame<K extends ClientMessageType>(msg: { type: K } & Record<string, unknown>): ClientMessageOf<K> {
  return msg as unknown as ClientMessageOf<K>;
}

function turn(sessionId: string | null = "s1", turnId = "t1"): RunningTurn {
  return {
    sessionId,
    turnId,
    principalId: "test-principal",
    pendingCancellationPrincipalIds: [],
    abortController: new AbortController(),
    timeoutHandle: setTimeout(() => {}, 0),
    queue: [],
    cancelled: false,
    lastResult: null,
  } as unknown as RunningTurn;
}

/** A pending request whose settlement is observable. */
function settleable<T>() {
  const seen: { resolved?: T; rejected?: string } = {};
  return {
    seen,
    resolve: (value: T) => { seen.resolved = value; },
    reject: (error: Error) => { seen.rejected = error.message; },
  };
}

function approval(t: RunningTurn, kind = "edit"): { entry: PendingApproval; decisions: unknown[] } {
  const decisions: unknown[] = [];
  return {
    decisions,
    entry: {
      turn: t,
      turnId: t.turnId,
      request: { toolUseId: "tu1", toolName: "Edit", kind, input: {} },
      resolve: (decision, response) => { decisions.push({ decision, response }); },
    } as unknown as PendingApproval,
  };
}

describe("the handler table", () => {
  test("ignores a frame whose type names an inherited property", async () => {
    // The table is a plain object; dispatch must not call Object.prototype.
    const { handleClientMessage } = await import("../src/ws/dispatch");
    // `__proto__` resolves to Object.prototype, which is not callable.
    const h = harness();
    await expect(
      handleClientMessage(h.ctx.host, ws, { type: "__proto__" } as unknown as ClientMessage, h.ctx.connection)
    ).resolves.toBeUndefined();
    expect(h.sent).toEqual([]);
  });

  test("passes the connection's echo requirement to the handler", async () => {
    const { handleClientMessage } = await import("../src/ws/dispatch");
    const h = harness();
    const t = turn();
    const pending = settleable<unknown>();
    h.coordinator.openLocation("loc1", { turn: t, turnId: "t1", ...pending });
    // A rev-3 client must echo; this reply does not, so it settles nothing.
    await handleClientMessage(h.ctx.host, ws, frame({ type: "location_error", requestId: "loc1", code: "denied" }),
      { ...h.ctx.connection, protocolRev: 3 });
    expect(pending.seen.rejected).toBeUndefined();
    expect(h.coordinator.pendingLocation.has("loc1")).toBe(true);
  });

  test("drops a frame on a revoked connection before any handler runs", async () => {
    const { handleClientMessage } = await import("../src/ws/dispatch");
    const h = harness();
    await handleClientMessage(h.ctx.host, ws, frame({ type: "ping", probeId: "p" }),
      { ...h.ctx.connection, authorization: { ...testAuthorization(), valid: false } as never });
    expect(h.sent).toEqual([]);
    expect(h.calls).toEqual(["dropped:revoked_principal"]);
  });

  test("has an own entry for every kind", () => {
    for (const handler of Object.values(CLIENT_MESSAGE_HANDLERS)) expect(typeof handler).toBe("function");
  });
});

describe("client_hello", () => {
  test("records the revision and capabilities and replays follow-up queues", () => {
    const capabilities: unknown[] = [];
    const h = harness({
      clients: { setCapabilities: (_ws: WSContext, caps: unknown) => { capabilities.push(caps); } },
      followUpQueueFrame: (sessionId: string) => ({ type: "follow_up_queue", sessionId, entries: [] }),
    });
    (h.coordinator as unknown as { sessionsWithFollowUps: () => string[] }).sessionsWithFollowUps = () => ["s1", "s2"];
    handleClientHello(h.ctx, frame({ type: "client_hello", protocolRev: 4, capabilities: { followUpQueue: true } }));
    expect(h.ctx.connection.protocolRev).toBe(4);
    expect(h.ctx.connection.capabilities).toEqual({ followUpQueue: true });
    expect(capabilities).toEqual([{ followUpQueue: true }]);
    expect(h.sent.map((m) => (m as { sessionId?: string }).sessionId)).toEqual(["s1", "s2"]);
  });
});

describe("chat_message", () => {
  test("refuses a share intake on a host without bound share filing", async () => {
    const h = harness();
    await handleChatMessageFrame(h.ctx, frame({ type: "chat_message", text: "hi", shareId: "sh1", requestId: "r1" }));
    expect(h.sent).toEqual([{ type: "error", code: "SESSION_BUSY", message: "This host does not support bound share filing", requestId: "r1" }]);
  });

  test("refuses track files on a host without a brain path", async () => {
    const h = harness();
    await handleChatMessageFrame(h.ctx, frame({ type: "chat_message", text: "hi", sessionId: "s1",
      files: [{ kind: "file", path: "tracks/a.md" }] }));
    expect(h.sent).toEqual([{ type: "error", code: "ATTACHMENT_REJECTED", message: "Track attachments are unavailable on this host.", sessionId: "s1" }]);
  });
});

describe("handoff frames", () => {
  test("handoff_status reports a created handoff from the catalog", () => {
    const h = harness({ catalog: { findHandoff: () => "s9" } });
    handleHandoffStatus(h.ctx, frame({ type: "handoff_status", handoffId: "h1" }));
    expect(h.sent).toEqual([{ type: "handoff_receipt", handoffId: "h1", state: "created", sessionId: "s9" }]);
  });

  test("handoff_prepare does nothing on a closed connection", async () => {
    const h = harness({}, { closed: true });
    await handleHandoffPrepare(h.ctx, frame({ type: "handoff_prepare", handoffId: "h1", sessionId: "s1" }));
    expect(h.sent).toEqual([]);
  });

  test("handoff_prepare_cancel aborts only this connection's preparation", () => {
    const h = harness();
    const mine = new AbortController();
    h.coordinator.registerHandoffPreparation("h1", { abort: mine, owner: h.ctx.connection });
    const theirs = new AbortController();
    h.coordinator.registerHandoffPreparation("h2", { abort: theirs, owner: {} });
    handleHandoffPrepareCancel(h.ctx, frame({ type: "handoff_prepare_cancel", handoffId: "h1" }));
    handleHandoffPrepareCancel(h.ctx, frame({ type: "handoff_prepare_cancel", handoffId: "h2" }));
    expect([mine.signal.aborted, theirs.signal.aborted]).toEqual([true, false]);
  });
});

describe("retry frames", () => {
  test("retry_status answers unknown when the catalog keeps no receipts", async () => {
    const h = harness();
    await handleRetryStatus(h.ctx, frame({ type: "retry_status", sessionId: "s1", requestId: "r1" }));
    expect(h.sent).toEqual([{ type: "retry_receipt", sessionId: "s1", requestId: "r1", state: "unknown" }]);
  });

  test("retry_turn refuses while the server is at its run cap", async () => {
    const h = harness({ maxConcurrentSessions: () => 0 });
    await handleRetryTurn(h.ctx, frame({ type: "retry_turn", sessionId: "s1", requestId: "r1", failedTurnId: "t0" }));
    expect(h.sent).toEqual([{ type: "retry_receipt", sessionId: "s1", requestId: "r1", state: "refused",
      message: "The server is busy. Wait for a turn to finish and try again." }]);
  });
});

describe("local_exchange", () => {
  test("says when the host does not keep local answers", async () => {
    const h = harness();
    await handleLocalExchange(h.ctx, frame({ type: "local_exchange", sessionId: "s1", exchange: { id: "x1" } }));
    expect(h.sent).toEqual([{ type: "local_exchange_result", sessionId: "s1", exchangeId: "x1", saved: false,
      reason: "This server does not keep local answers." }]);
  });
});

describe("scope_decision", () => {
  test("refuses on a host without a scope service", async () => {
    const h = harness();
    await handleScopeDecision(h.ctx, frame({ type: "scope_decision", sessionId: "s1", turnId: "t1", decisionId: "d1" }));
    expect(h.sent).toEqual([{ type: "scope_decision_receipt", sessionId: "s1", turnId: "t1", decisionId: "d1",
      state: "refused", reason: "This host cannot answer scope decisions." }]);
  });
});

describe("ask frames", () => {
  test("an answer without a submission id is dropped and told to update", () => {
    const h = harness();
    for (const type of ["ask_user_response", "ask_user_list_response", "ask_user_rank_response", "ask_user_form_response"] as const) {
      handleAskAnswerFrame(h.ctx, frame({ type, requestId: "q1" }));
    }
    expect(h.calls).toEqual(Array(4).fill("dropped:ask_answer_without_receipt"));
    expect(h.sent.map((m) => m.type)).toEqual(["error", "error", "error", "error"]);
  });

  test("ask_answer_status reports a pending ask", () => {
    const h = harness();
    const t = turn();
    h.coordinator.openAsk("ask_user", { turn: t, turnId: "t1", requestId: "q1", questions: [], ...settleable() } as never);
    handleAskAnswerStatusFrame(h.ctx, frame({ type: "ask_answer_status", requestId: "q1", submissionId: "sub1" }));
    expect(h.sent).toMatchObject([{ requestId: "q1", submissionId: "sub1", state: "pending", sessionId: "s1", turnId: "t1" }]);
  });

  test("ask_user_cancel rejects a matching ask and records the dismissal", () => {
    const h = harness({}, {}, true);
    const t = turn();
    const pending = settleable<unknown>();
    h.coordinator.openAsk("ask_user", { turn: t, turnId: "t1", requestId: "q1", questions: [], ...pending } as never);
    handleAskUserCancel(h.ctx, frame({ type: "ask_user_cancel", requestId: "q1" }));
    expect(pending.seen.rejected).toBeUndefined(); // a rev-3 client must echo
    handleAskUserCancel(h.ctx, frame({ type: "ask_user_cancel", requestId: "q1", turnId: "t1", reason: "not now" }));
    expect(pending.seen.rejected).toBe("not now");
    expect(h.coordinator.askOutcome("q1")).toMatchObject({ state: "closed", reason: "cancelled" });
  });
});

describe("ping", () => {
  test("answers with a pong carrying the probe id", () => {
    const h = harness();
    handlePing(h.ctx, frame({ type: "ping", probeId: "p1" }));
    expect(h.sent).toEqual([{ type: "pong", probeId: "p1" }]);
  });
});

describe("location frames", () => {
  test("location_response resolves the matching request", () => {
    const h = harness();
    const pending = settleable<unknown>();
    h.coordinator.openLocation("l1", { turn: turn(), turnId: "t1", ...pending });
    handleLocationResponse(h.ctx, frame({ type: "location_response", requestId: "l1", turnId: "t1", coords: { latitude: 1 }, timestamp: 5 }));
    expect(pending.seen.resolved).toEqual({ coords: { latitude: 1 }, timestamp: 5 });
  });

  test("location_error rejects the request, and a wrong turn leaves it pending", () => {
    const h = harness();
    const pending = settleable<unknown>();
    h.coordinator.openLocation("l1", { turn: turn(), turnId: "t1", ...pending });
    handleLocationError(h.ctx, frame({ type: "location_error", requestId: "l1", turnId: "other", code: "denied" }));
    expect(h.coordinator.pendingLocation.has("l1")).toBe(true);
    handleLocationError(h.ctx, frame({ type: "location_error", requestId: "l1", turnId: "t1", code: "denied" }));
    expect(pending.seen.rejected).toBeString();
    expect(h.coordinator.pendingLocation.has("l1")).toBe(false);
  });
});

describe("mask frames", () => {
  test("mask_response decodes the PNG bytes", () => {
    const h = harness();
    const pending = settleable<Uint8Array>();
    h.coordinator.openMask("m1", { turn: turn(), turnId: "t1", ...pending });
    handleMaskResponse(h.ctx, frame({ type: "mask_response", requestId: "m1", maskPng: Buffer.from([1, 2, 3]).toString("base64") }));
    expect([...pending.seen.resolved!]).toEqual([1, 2, 3]);
  });

  test("mask_error names a cancelled mark", () => {
    const h = harness();
    const pending = settleable<Uint8Array>();
    h.coordinator.openMask("m1", { turn: turn(), turnId: "t1", ...pending });
    handleMaskError(h.ctx, frame({ type: "mask_error", requestId: "m1", code: "cancelled", message: "closed" }));
    expect(pending.seen.rejected).toBe("The user did not mark an area: closed");
  });
});

describe("tool permission frames", () => {
  test("tool_approval grants a matching request and refuses to remember a command", async () => {
    const h = harness({ toolPermissions: { add: async () => {} } });
    const { entry, decisions } = approval(turn(), "command");
    h.coordinator.openApproval("tu1", entry);
    await handleToolApproval(h.ctx, frame({ type: "tool_approval", toolUseId: "tu1", turnId: "t1", always: true }));
    expect(decisions).toEqual([{ decision: { behavior: "allow" }, response: { principalId: "test-principal" } }]);
    expect(h.calls).toEqual(["log:always-allow not remembered"]);
    expect(h.coordinator.resolvedApprovals.get("tu1")).toMatchObject({ outcome: "granted" });
  });

  test("tool_approval refuses a voice grant and re-sends the card", async () => {
    const h = harness();
    const { entry, decisions } = approval(turn());
    h.coordinator.openApproval("tu1", entry);
    await handleToolApproval(h.ctx, frame({ type: "tool_approval", toolUseId: "tu1", turnId: "t1", channel: "voice" }));
    expect(decisions).toEqual([]);
    expect(h.coordinator.pendingApprovals.has("tu1")).toBe(true);
    expect(h.calls).toEqual(["log:voice-attributed grant refused"]);
    expect(h.sent).toMatchObject([{ type: "tool_approval_request", toolUseId: "tu1", turnId: "t1" }]);
  });

  test("tool_approval for nothing pending is answered unknown to a resolution-aware client", async () => {
    const h = harness({}, { capabilities: { toolResolution: true } });
    await handleToolApproval(h.ctx, frame({ type: "tool_approval", toolUseId: "tu9", turnId: "t1" }));
    expect(h.sent).toEqual([{ type: "tool_resolution", toolUseId: "tu9", outcome: "unknown", turnId: "t1" }]);
  });

  test("tool_denial denies a matching request, and a late denial learns the grant", () => {
    const h = harness({}, { capabilities: { toolResolution: true } });
    const { entry, decisions } = approval(turn());
    h.coordinator.openApproval("tu1", entry);
    handleToolDenial(h.ctx, frame({ type: "tool_denial", toolUseId: "tu1", turnId: "t1", message: "no" }));
    expect(decisions).toEqual([{ decision: { behavior: "deny", message: "no" }, response: { principalId: "test-principal" } }]);
    handleToolDenial(h.ctx, frame({ type: "tool_denial", toolUseId: "tu1", turnId: "t1", message: "again" }));
    expect(h.sent).toEqual([{ type: "tool_resolution", toolUseId: "tu1", outcome: "denied", sessionId: "s1", turnId: "t1" }]);
  });
});

describe("cancel", () => {
  test("cancels a session's running turn and tells its conversation", () => {
    const cancelled: string[] = [];
    const h = harness({ conversations: { sessionCancelled: (id: string) => { cancelled.push(id); } } });
    const t = turn();
    h.coordinator.registerTurn(t);
    handleCancel(h.ctx, frame({ type: "cancel", sessionId: "s1" }));
    expect(t.cancelled).toBe(true);
    expect(t.abortController.signal.aborted).toBe(true);
    expect(t.pendingCancellationPrincipalIds).toEqual(["test-principal"]);
    expect(cancelled).toEqual(["s1"]);
  });

  test("refuses an unscoped cancel while several sessions run", () => {
    const h = harness();
    h.coordinator.registerTurn(turn("s1"));
    h.coordinator.registerTurn(turn("s2"));
    handleCancel(h.ctx, frame({ type: "cancel" }));
    expect(h.sent).toMatchObject([{ type: "error", code: "CANCEL_AMBIGUOUS" }]);
  });
});

describe("inbox frames", () => {
  test("each inbox frame says when the host has no inbox", () => {
    const h = harness();
    handleInboxDecision(h.ctx, frame({ type: "inbox_resolve", id: "i1" }));
    handleInboxDecision(h.ctx, frame({ type: "inbox_snooze", id: "i1" }));
    handleInboxSubscribe(h.ctx, frame({ type: "inbox_subscribe" }));
    handleInboxUnsubscribe(h.ctx, frame({ type: "inbox_unsubscribe" }));
    expect(h.sent.map((m) => (m as { code?: string }).code)).toEqual(Array(4).fill("INBOX_UNAVAILABLE"));
  });

  test("forwards to the inbox, and not on a closed connection", () => {
    const seen: string[] = [];
    const inbox = {
      handleDecision: (_ws: WSContext, msg: ClientMessage) => { seen.push(msg.type); },
      handleSubscribe: (_ws: WSContext, msg: ClientMessage) => { seen.push(msg.type); },
      handleUnsubscribe: (_ws: WSContext, msg: ClientMessage) => { seen.push(msg.type); },
    };
    const open = harness({ inbox });
    handleInboxDecision(open.ctx, frame({ type: "inbox_snooze", id: "i1" }));
    handleInboxSubscribe(open.ctx, frame({ type: "inbox_subscribe" }));
    handleInboxUnsubscribe(open.ctx, frame({ type: "inbox_unsubscribe" }));
    const closed = harness({ inbox }, { closed: true });
    handleInboxSubscribe(closed.ctx, frame({ type: "inbox_subscribe" }));
    expect(seen).toEqual(["inbox_snooze", "inbox_subscribe", "inbox_unsubscribe"]);
  });
});

describe("activity frames", () => {
  test("subscribes an open connection only, and always unsubscribes", () => {
    const seen: string[] = [];
    const activity = { stream: {
      handleSubscribe: (_ws: WSContext, _msg: unknown, principalId: string) => { seen.push(`sub:${principalId}`); },
      handleUnsubscribe: () => { seen.push("unsub"); },
    } };
    handleActivitySubscribe(harness({ activity }, { closed: true }).ctx, frame({ type: "activity_subscribe" }));
    const h = harness({ activity });
    handleActivitySubscribe(h.ctx, frame({ type: "activity_subscribe" }));
    handleActivityUnsubscribe(h.ctx, frame({ type: "activity_unsubscribe" }));
    expect(seen).toEqual(["sub:test-principal", "unsub"]);
  });
});

describe("conversation frames", () => {
  const handlers = {
    conversation_start: handleConversationStart,
    conversation_audio: handleConversationAudio,
    conversation_endpoint: handleConversationEndpoint,
    conversation_commit: handleConversationCommit,
    conversation_playback: handleConversationPlayback,
    conversation_stop: handleConversationStop,
  } as const;

  test("each frame reaches its own conversation method", async () => {
    const seen: string[] = [];
    const record = (name: string) => () => { seen.push(name); };
    const conversations = { start: async () => { seen.push("start"); }, audio: record("audio"), endpoint: record("endpoint"),
      commit: record("commit"), playback: record("playback"), stop: record("stop") };
    const h = harness({ conversations });
    for (const [type, handle] of Object.entries(handlers)) {
      await (handle as (ctx: HandlerContext, msg: unknown) => unknown)(h.ctx, frame({ type: type as ClientMessageType }));
    }
    expect(seen).toEqual(["start", "audio", "endpoint", "commit", "playback", "stop"]);
  });

  test("a host without conversations says so; a closed connection hears nothing", () => {
    const h = harness();
    handleConversationAudio(h.ctx, frame({ type: "conversation_audio" }));
    handleConversationStop(harness({}, { closed: true }).ctx, frame({ type: "conversation_stop" }));
    expect(h.sent).toMatchObject([{ type: "error", code: "CONVERSATION_UNAVAILABLE" }]);
  });
});

describe("dialogue_read", () => {
  test("is silent without the capability, and reports an unavailable owner", async () => {
    const dialogueRead = async () => null;
    const without = harness({ catalog: { dialogueRead } });
    await handleDialogueRead(without.ctx, frame({ type: "dialogue_read", requestId: "r1" }));
    expect(without.sent).toEqual([]);
    const h = harness({ catalog: { dialogueRead } }, { capabilities: { sessionDialogue: true } });
    await handleDialogueRead(h.ctx, frame({ type: "dialogue_read", requestId: "r1" }));
    expect(h.sent).toMatchObject([{ type: "error", code: "DIALOGUE_UNAVAILABLE", requestId: "r1" }]);
  });
});

describe("session_resume", () => {
  test("reports a catalog failure once, as a load error", async () => {
    const h = harness({ catalog: { hasSession: () => { throw new Error("disk"); } } });
    await handleSessionResume(h.ctx, frame({ type: "session_resume", sessionId: "s1" }));
    expect(h.sent).toMatchObject([{ type: "error", code: "SESSION_LOAD_ERROR", sessionId: "s1" }]);
    expect(h.calls).toEqual(["resume:error", "failed:SESSION_LOAD_ERROR"]);
  });
});

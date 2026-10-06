/**
 * The activity stream, driven through the real inbound path: spans derive
 * from the frames the host relays, deltas follow committed writes
 * (persist-then-emit), subscriptions are view-scoped, and a foreign writer's
 * rows surface through the same change-log pump.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { AgentBackend, BackendBridge } from "@schlessera/brain-ui-sdk/server";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore, type ActivityStore } from "../src/activity/store";
import { createActivityStream, type ActivityStream } from "../src/activity/stream";
import { createUiDb } from "../src/db/client";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost, type ToolPermissions } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

function fakeSocket(raw?: unknown): WSContext & { sent: string[]; frames: () => any[] } {
  const sent: string[] = [];
  return {
    send: (data: string) => sent.push(data),
    close: () => {},
    ...(raw === undefined ? {} : { raw }),
    readyState: 1,
    sent,
    frames: () => sent.map((s) => JSON.parse(s)),
  } as unknown as WSContext & { sent: string[]; frames: () => any[] };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Setup {
  db: ReturnType<typeof createUiDb>;
  store: ActivityStore;
  stream: ActivityStream;
  host: WsHost;
  handlers: ReturnType<typeof createWsHandlers>;
}

function setup(
  startTurn?: AgentBackend["startTurn"],
  backendOptions: {
    capabilities?: Partial<AgentBackend["capabilities"]>;
    followUp?: AgentBackend["followUp"];
  } = {},
  hostOptions: { toolPermissions?: ToolPermissions } = {}
): Setup {
  const db = createUiDb(":memory:");
  const observability = createRecordingObservability();
  const store = createActivityStore(db, { writer: "server-test" });
  const stream = createActivityStream(store);
  const backend = makeFakeBackend({
    id: "fake",
    startTurn,
    ...backendOptions,
  });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    observability,
    activity: { store, stream },
    ...(hostOptions.toolPermissions
      ? { toolPermissions: hostOptions.toolPermissions }
      : {}),
  });
  return { db, store, stream, host, handlers: createWsHandlers(host, testPrincipal()) };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** A backend turn that announces a session and runs one tool call. */
function scriptedTurn(sessionId = "sess-1") {
  return async ({ bridge }: { bridge: BackendBridge }) => {
    bridge.emit({ type: "session_info", sessionId, isNew: true });
    bridge.emit({ type: "tool_use_start", toolUseId: "t1", toolName: "Read" });
    bridge.emit({ type: "tool_result", toolUseId: "t1", output: "ok", isError: false });
    bridge.emit({
      type: "result",
      sessionId,
      outcome: "success",
      costUsd: 0.05,
      durationMs: 42,
      numTurns: 1,
      isError: false,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  };
}

function openAndSubscribe(s: Setup, sub: Record<string, unknown>) {
  const ws = fakeSocket();
  s.handlers.onOpen(undefined as never, ws);
  s.handlers.onMessage({ data: JSON.stringify(sub) } as MessageEvent, ws);
  return ws;
}

describe("activity stream over the ws path", () => {
  test("a turn produces a span tree and ordered deltas to a session subscriber", async () => {
    const s = setup(scriptedTurn());
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const ws = openAndSubscribe(s, {
      type: "activity_subscribe",
      view: "session",
      sessionId: "sess-1",
    });
    // Subscription precedes the turn: the snapshot is empty, everything
    // arrives as deltas.
    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent,
      ws
    );
    await until(() => ws.frames().some((f) => f.type === "result"));
    await until(() =>
      ws.frames().some((f) => f.type === "activity_delta" && f.span?.outcome === "success" && f.span?.kind === "turn")
    );

    const deltas = ws.frames().filter((f) => f.type === "activity_delta");
    // Ordered, gapless seq per run.
    const seqs = deltas.map((d) => d.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const kinds = deltas.filter((d) => d.span).map((d) => d.span.kind);
    expect(kinds).toContain("turn");
    expect(kinds).toContain("tool");
    // The terminal turn span carries the usage the result frame reported.
    const terminal = deltas.filter((d) => d.span?.kind === "turn").at(-1)!.span;
    expect(terminal.principalId).toBe("test-principal");
    expect(terminal.usage.inputTokens).toBe(100);
    expect(terminal.usage.costUsd).toBe(0.05);
    // Timing survives: the store's rows equal what streamed (AE2 server half).
    const runId = terminal.runId;
    const snap = s.store.snapshotRun(runId)!;
    expect(snap.spans.find((x) => x.kind === "tool")!.outcome).toBe("success");
  });

  test("an unsubscribed connection receives no activity frames", async () => {
    const s = setup(scriptedTurn());
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const ws = fakeSocket();
    s.handlers.onOpen(undefined as never, ws);
    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent,
      ws
    );
    await until(() => ws.frames().some((f) => f.type === "result"));
    expect(ws.frames().filter((f) => f.type.startsWith("activity_"))).toHaveLength(0);
    // Chat frames still flow — broadcast semantics untouched.
    expect(ws.frames().some((f) => f.type === "tool_result")).toBe(true);
  });

  test("a queued follow-up root is attributed to its own sender, not the initiator", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const prompts: string[] = [];
    const s = setup(async (request) => {
      prompts.push(request.prompt);
      request.bridge.emit({
        type: "session_info",
        sessionId: "sess-follow",
        isNew: prompts.length === 1,
      });
      if (request.prompt === "first") await firstHeld;
      request.bridge.emit({
        type: "result",
        sessionId: "sess-follow",
        outcome: "success",
        durationMs: 1,
        numTurns: 1,
        isError: false,
      });
    });
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const initiator = fakeSocket();
    const follower = fakeSocket();
    const followerHandlers = createWsHandlers(s.host, testPrincipal("principal-b"));
    await s.handlers.onOpen(undefined as never, initiator);
    await followerHandlers.onOpen(undefined as never, follower);

    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "first" }) } as MessageEvent,
      initiator
    );
    await until(() => s.host.coordinator.bySession.has("sess-follow"));
    followerHandlers.onMessage(
      {
        data: JSON.stringify({
          type: "chat_message",
          text: "second",
          sessionId: "sess-follow",
        }),
      } as MessageEvent,
      follower
    );
    await until(() =>
      follower.frames().some((f) => f.type === "status" && f.status === "queued")
    );
    releaseFirst();
    await until(() => initiator.frames().filter((f) => f.type === "result").length === 2);

    const [firstResult, secondResult] = initiator.frames().filter((f) => f.type === "result");
    expect(prompts).toEqual(["first", "second"]);
    expect(s.store.getSpan(`${firstResult.turnId}:turn`)!.principalId).toBe("test-principal");
    expect(s.store.getSpan(`${secondResult.turnId}:turn`)!.principalId).toBe("principal-b");
    expect(s.store.getSpan(`${secondResult.turnId}:turn`)!.principalId).not.toBe("test-principal");
  });

  test("a live follow-up is attributed to its own sender", async () => {
    let releaseTurn!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const followUps: string[] = [];
    const s = setup(
      async ({ bridge }) => {
        bridge.emit({ type: "session_info", sessionId: "sess-live-follow", isNew: true });
        await held;
        bridge.emit({
          type: "result",
          sessionId: "sess-live-follow",
          outcome: "success",
          durationMs: 1,
          numTurns: 1,
          isError: false,
        });
      },
      {
        capabilities: { followUp: true },
        followUp: async ({ prompt }) => {
          followUps.push(prompt);
        },
      }
    );
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const initiator = fakeSocket();
    const follower = fakeSocket();
    const followerHandlers = createWsHandlers(s.host, testPrincipal("principal-b"));
    await s.handlers.onOpen(undefined as never, initiator);
    await followerHandlers.onOpen(undefined as never, follower);

    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "first" }) } as MessageEvent,
      initiator
    );
    await until(() => s.host.coordinator.bySession.has("sess-live-follow"));
    followerHandlers.onMessage(
      {
        data: JSON.stringify({
          type: "chat_message",
          text: "live follow",
          sessionId: "sess-live-follow",
        }),
      } as MessageEvent,
      follower
    );
    await until(() => followUps.length === 1);

    const turn = s.host.coordinator.bySession.get("sess-live-follow")!;
    expect(followUps).toEqual(["live follow"]);
    expect(s.store.snapshotRun(turn.turnId)!.events).toContainEqual(
      expect.objectContaining({
        eventType: "follow_up",
        payload: { principalId: "principal-b" },
      })
    );

    releaseTurn();
    await until(() => initiator.frames().some((frame) => frame.type === "result"));
  });

  test("a cancellation is attributed to the responding principal", async () => {
    const s = setup(async (request) => {
      request.bridge.emit({ type: "session_info", sessionId: "sess-cancel", isNew: true });
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const initiator = fakeSocket();
    const responder = fakeSocket();
    const responderHandlers = createWsHandlers(s.host, testPrincipal("principal-b"));
    await s.handlers.onOpen(undefined as never, initiator);
    await responderHandlers.onOpen(undefined as never, responder);

    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent,
      initiator
    );
    await until(() => s.host.coordinator.bySession.has("sess-cancel"));
    responderHandlers.onMessage(
      { data: JSON.stringify({ type: "cancel", sessionId: "sess-cancel" }) } as MessageEvent,
      responder
    );
    await until(() => s.host.coordinator.running.size === 0);

    const root = s.store.changesSince(0).find((change) => change.kind === "span")!;
    const snapshot = s.store.snapshotRun(root.runId)!;
    expect(snapshot.spans.find((span) => span.kind === "turn")!.principalId).toBe("test-principal");
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({
        eventType: "turn_cancelled",
        payload: { principalId: "principal-b" },
      })
    );
  });

  test("a cancellation during billing is attributed after the recorder starts", async () => {
    const billing = deferred();
    let billingCalls = 0;
    const s = setup();
    s.host.registry.listAllProviders = async () => {
      billingCalls += 1;
      await billing.promise;
      return [];
    };
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const initiator = fakeSocket();
    const responder = fakeSocket();
    const responderHandlers = createWsHandlers(s.host, testPrincipal("principal-b"));
    await s.handlers.onOpen(undefined as never, initiator);
    await responderHandlers.onOpen(undefined as never, responder);

    s.handlers.onMessage(
      {
        data: JSON.stringify({
          type: "chat_message",
          text: "go",
          sessionId: "sess-startup-cancel",
        }),
      } as MessageEvent,
      initiator
    );
    await until(() => billingCalls === 1);
    responderHandlers.onMessage(
      {
        data: JSON.stringify({ type: "cancel", sessionId: "sess-startup-cancel" }),
      } as MessageEvent,
      responder
    );
    await until(
      () => s.host.coordinator.bySession.get("sess-startup-cancel")?.cancelled === true
    );
    billing.resolve();
    await until(() => s.host.coordinator.running.size === 0);

    const root = s.store.changesSince(0).find((change) => change.kind === "span")!;
    const snapshot = s.store.snapshotRun(root.runId)!;
    expect(snapshot.spans.find((span) => span.kind === "turn")).toEqual(
      expect.objectContaining({ outcome: "cancelled", principalId: "test-principal" })
    );
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({
        eventType: "turn_cancelled",
        payload: { principalId: "principal-b" },
      })
    );
  });

  test("a sessionless cancellation during billing retains its responder", async () => {
    const billing = deferred();
    let billingCalls = 0;
    const s = setup();
    s.host.registry.listAllProviders = async () => {
      billingCalls += 1;
      await billing.promise;
      return [];
    };
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const initiator = fakeSocket();
    const responder = fakeSocket();
    const responderHandlers = createWsHandlers(s.host, testPrincipal("principal-b"));
    await s.handlers.onOpen(undefined as never, initiator);
    await responderHandlers.onOpen(undefined as never, responder);

    s.handlers.onMessage(
      {
        data: JSON.stringify({
          type: "chat_message",
          text: "go",
          sessionId: "sess-sessionless-cancel",
        }),
      } as MessageEvent,
      initiator
    );
    await until(() => billingCalls === 1);
    responderHandlers.onMessage(
      { data: JSON.stringify({ type: "cancel" }) } as MessageEvent,
      responder
    );
    await until(
      () => s.host.coordinator.bySession.get("sess-sessionless-cancel")?.cancelled === true
    );
    billing.resolve();
    await until(() => s.host.coordinator.running.size === 0);

    const root = s.store.changesSince(0).find((change) => change.kind === "span")!;
    expect(s.store.snapshotRun(root.runId)!.events).toContainEqual(
      expect.objectContaining({
        eventType: "turn_cancelled",
        payload: { principalId: "principal-b" },
      })
    );
  });

  test("subscribing to a terminal run returns a snapshot with high-water, then silence (AE6)", async () => {
    const s = setup(scriptedTurn());
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const ws = fakeSocket();
    s.handlers.onOpen(undefined as never, ws);
    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent,
      ws
    );
    await until(() => ws.frames().some((f) => f.type === "result"));
    await until(() => s.store.openRootSpans().length === 0);
    const runId = s.store.changesSince(0)[0]!.runId;

    const late = openAndSubscribe(s, { type: "activity_subscribe", view: "run", runId });
    await until(() => late.frames().some((f) => f.type === "activity_snapshot"));
    const snapshot = late.frames().find((f) => f.type === "activity_snapshot");
    expect(snapshot.highWaterSeq[runId]).toBeGreaterThan(0);
    expect(snapshot.spans.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.spans.find((span: any) => span.kind === "turn")!.principalId).toBe(
      "test-principal"
    );
    // Everything the store holds for the run is at or below the high-water:
    // nothing can arrive later that the snapshot did not already cover.
    const maxSeq = Math.max(...s.store.changesSince(0).filter((c) => c.runId === runId).map((c) => c.seq));
    expect(snapshot.highWaterSeq[runId]).toBe(maxSeq);
    s.stream.pump();
    expect(late.frames().filter((f) => f.type === "activity_delta")).toHaveLength(0);
  });

  test("a denied approval lands as a denied span with the wait recorded (AE1)", async () => {
    let denied: string | undefined;
    const s = setup(async ({ bridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-1", isNew: true });
      bridge.emit({ type: "tool_use_start", toolUseId: "t-gated", toolName: "Bash" });
      const decision = await bridge.requestPermission({
        toolUseId: "t-gated",
        toolName: "Bash",
        input: { command: "rm -rf" },
      });
      denied = decision.behavior;
      // The SDK would surface an error tool_result after a denial — the
      // write-once denied outcome must survive it.
      bridge.emit({ type: "tool_result", toolUseId: "t-gated", output: "denied", isError: true });
      bridge.emit({
        type: "result",
        sessionId: "sess-1",
        outcome: "success",
        durationMs: 5,
        numTurns: 1,
        isError: false,
      });
    });
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const ws = fakeSocket();
    const responder = fakeSocket();
    const responderHandlers = createWsHandlers(s.host, testPrincipal("principal-b"));
    await s.handlers.onOpen(undefined as never, ws);
    await responderHandlers.onOpen(undefined as never, responder);
    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent,
      ws
    );
    await until(() => ws.frames().some((f) => f.type === "tool_approval_request"));
    const req = ws.frames().find((f) => f.type === "tool_approval_request");
    responderHandlers.onMessage(
      {
        data: JSON.stringify({
          type: "tool_denial",
          toolUseId: "t-gated",
          message: "no",
          turnId: req.turnId,
        }),
      } as MessageEvent,
      responder
    );
    await until(() => ws.frames().some((f) => f.type === "result"));
    expect(denied).toBe("deny");
    const span = s.store.getSpan("t-gated")!;
    expect(span.outcome).toBe("denied");
    expect(span.outcomeReason).toBe("user declined");
    expect(span.principalId).toBe("principal-b");
    expect(span.principalId).not.toBe("test-principal");
    expect(s.store.snapshotRun(span.runId)!.events).toContainEqual(
      expect.objectContaining({
        eventType: "approval_decision",
        payload: {
          principalId: "principal-b",
          decision: "deny",
          requestKind: "tool",
        },
      })
    );
  });

  test("two approvals for one tool retain both responders as immutable events", async () => {
    const s = setup(async ({ bridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-two-approvals", isNew: true });
      bridge.emit({ type: "tool_use_start", toolUseId: "t-double", toolName: "Bash" });
      await bridge.requestPermission({
        toolUseId: "t-double",
        toolName: "Bash",
        input: { command: "echo safe" },
        kind: "command",
      });
      await bridge.requestPermission({
        toolUseId: "t-double",
        toolName: "Bash",
        input: { command: "echo safe" },
        kind: "tool",
      });
      bridge.emit({ type: "tool_result", toolUseId: "t-double", output: "ok", isError: false });
      bridge.emit({
        type: "result",
        sessionId: "sess-two-approvals",
        outcome: "success",
        durationMs: 1,
        numTurns: 1,
        isError: false,
      });
    });
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const initiator = fakeSocket();
    const responderB = fakeSocket();
    const responderC = fakeSocket();
    const handlersB = createWsHandlers(s.host, testPrincipal("principal-b"));
    const handlersC = createWsHandlers(s.host, testPrincipal("principal-c"));
    await s.handlers.onOpen(undefined as never, initiator);
    await handlersB.onOpen(undefined as never, responderB);
    await handlersC.onOpen(undefined as never, responderC);

    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent,
      initiator
    );
    await until(
      () => initiator.frames().filter((frame) => frame.type === "tool_approval_request").length === 1
    );
    const first = initiator.frames().find((frame) => frame.type === "tool_approval_request");
    handlersB.onMessage(
      {
        data: JSON.stringify({
          type: "tool_approval",
          toolUseId: "t-double",
          turnId: first.turnId,
        }),
      } as MessageEvent,
      responderB
    );
    await until(
      () => initiator.frames().filter((frame) => frame.type === "tool_approval_request").length === 2
    );
    const second = initiator
      .frames()
      .filter((frame) => frame.type === "tool_approval_request")
      .at(-1)!;
    handlersC.onMessage(
      {
        data: JSON.stringify({
          type: "tool_approval",
          toolUseId: "t-double",
          turnId: second.turnId,
        }),
      } as MessageEvent,
      responderC
    );
    await until(() => initiator.frames().some((frame) => frame.type === "result"));

    const decisions = s.store
      .snapshotRun(s.store.getSpan("t-double")!.runId)!
      .events.filter((event) => event.eventType === "approval_decision");
    expect(decisions.map((event) => event.payload)).toEqual([
      { principalId: "principal-b", decision: "allow", requestKind: "command" },
      { principalId: "principal-c", decision: "allow", requestKind: "tool" },
    ]);
  });

  test("principal B is recorded for ordinary and always-allow approvals on A's turn", async () => {
    // A real grants store, because "always_allow" on the record means a grant
    // was actually kept — not that the user asked for one. Without it the host
    // refuses to remember and records an ordinary `allow`, which is correct
    // and would make this test's second row stop covering the path it names.
    const granted = new Set<string>();
    const s = setup(
      async ({ bridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-affirmative", isNew: true });
      for (const toolUseId of ["t-ordinary", "t-always"]) {
        bridge.emit({ type: "tool_use_start", toolUseId, toolName: "Write" });
        await bridge.requestPermission({
          toolUseId,
          toolName: "Write",
          input: { path: "/tmp/example" },
          kind: "tool",
        });
        bridge.emit({ type: "tool_result", toolUseId, output: "ok", isError: false });
      }
      bridge.emit({
        type: "result",
        sessionId: "sess-affirmative",
        outcome: "success",
        durationMs: 1,
        numTurns: 1,
        isError: false,
      });
      },
      {},
      {
        toolPermissions: {
          isAutoAllowed: (name) => granted.has(name),
          add: (name) => granted.add(name),
        },
      }
    );
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const initiator = fakeSocket();
    const responder = fakeSocket();
    const responderHandlers = createWsHandlers(s.host, testPrincipal("principal-b"));
    await s.handlers.onOpen(undefined as never, initiator);
    await responderHandlers.onOpen(undefined as never, responder);

    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent,
      initiator
    );
    await until(
      () => initiator.frames().filter((frame) => frame.type === "tool_approval_request").length === 1
    );
    const ordinary = initiator.frames().find((frame) => frame.type === "tool_approval_request");
    responderHandlers.onMessage(
      {
        data: JSON.stringify({
          type: "tool_approval",
          toolUseId: "t-ordinary",
          turnId: ordinary.turnId,
        }),
      } as MessageEvent,
      responder
    );
    await until(
      () => initiator.frames().filter((frame) => frame.type === "tool_approval_request").length === 2
    );
    const always = initiator
      .frames()
      .filter((frame) => frame.type === "tool_approval_request")
      .at(-1)!;
    responderHandlers.onMessage(
      {
        data: JSON.stringify({
          type: "tool_approval",
          toolUseId: "t-always",
          always: true,
          turnId: always.turnId,
        }),
      } as MessageEvent,
      responder
    );
    await until(() => initiator.frames().some((frame) => frame.type === "result"));

    const events = s.store
      .snapshotRun(s.store.getSpan("t-ordinary")!.runId)!
      .events.filter((event) => event.eventType === "approval_decision");
    expect(events.map((event) => event.payload)).toEqual([
      { principalId: "principal-b", decision: "allow", requestKind: "tool" },
      { principalId: "principal-b", decision: "always_allow", requestKind: "tool" },
    ]);
    expect(s.store.getSpan("t-ordinary")!.principalId).toBe("principal-b");
    expect(s.store.getSpan("t-always")!.principalId).toBe("principal-b");
    // The `always_allow` row above is only honest if a grant was in fact kept.
    expect([...granted]).toEqual(["Write"]);
  });

  test("an ask-user answer records the responding principal", async () => {
    let answers: Record<string, string> | null = null;
    const s = setup(async ({ bridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-ask-user", isNew: true });
      answers = (
        await bridge.askUser!("ask-1", [
          {
            question: "Continue?",
            header: "Continue",
            multiSelect: false,
            options: [
              { label: "Yes", description: "Continue the turn." },
              { label: "No", description: "Stop here." },
            ],
          },
        ])
      ).answers;
      bridge.emit({
        type: "result",
        sessionId: "sess-ask-user",
        outcome: "success",
        durationMs: 1,
        numTurns: 1,
        isError: false,
      });
    });
    cleanup = () => {
      s.host.close();
      s.stream.close();
      s.db.close();
    };
    const initiator = fakeSocket();
    const responder = fakeSocket();
    const responderHandlers = createWsHandlers(s.host, testPrincipal("principal-b"));
    await s.handlers.onOpen(undefined as never, initiator);
    await responderHandlers.onOpen(undefined as never, responder);

    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent,
      initiator
    );
    await until(() => initiator.frames().some((frame) => frame.type === "ask_user_request"));
    const request = initiator.frames().find((frame) => frame.type === "ask_user_request");
    responderHandlers.onMessage(
      {
        data: JSON.stringify({
          type: "ask_user_response",
          requestId: "ask-1",
          submissionId: "sub-5",
          answers: { "Continue?": "Yes" },
          turnId: request.turnId,
        }),
      } as MessageEvent,
      responder
    );
    await until(() => initiator.frames().some((frame) => frame.type === "result"));

    expect(answers as Record<string, string> | null).toEqual({ "Continue?": "Yes" });
    const row = s.db
      .query(
        "SELECT payload FROM activity_events WHERE event_type = 'ask_user_response'"
      )
      .get() as { payload: string };
    expect(JSON.parse(row.payload).v).toEqual({ principalId: "principal-b" });
  });

  test("a foreign writer's run surfaces through the pump while subscribed, and index view sees it", async () => {
    const s = setup(scriptedTurn());
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const ws = openAndSubscribe(s, { type: "activity_subscribe", view: "index" });
    await until(() => ws.frames().some((f) => f.type === "activity_snapshot"));

    // A second store handle simulates the cron wrapper's process.
    const cron = createActivityStore(s.db, { writer: "cron-test" });
    cron.startSpan({
      spanId: "cron-root-1",
      runId: "cron-run-1",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    s.stream.pump();
    const delta = ws.frames().find((f) => f.type === "activity_delta" && f.runId === "cron-run-1");
    expect(delta.span.kind).toBe("cron");
    expect(delta.span.jobName).toBe("sync");
    expect("principalId" in delta.span).toBe(false);

    // After unsubscribe, further foreign writes reach nobody. The handler
    // path is async — wait for the subscription to actually drop.
    s.handlers.onMessage(
      { data: JSON.stringify({ type: "activity_unsubscribe", view: "index" }) } as MessageEvent,
      ws
    );
    await until(() => s.stream.subscriptionCount() === 0);
    const before = ws.frames().length;
    cron.endSpan("cron-root-1", { outcome: "success" });
    s.stream.pump();
    expect(ws.frames().length).toBe(before);
  });

  test("a socket close drops its subscriptions; the pump then reaches nobody", async () => {
    const s = setup(scriptedTurn());
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    // Hono creates a fresh WSContext for open/message/close. Only `raw` is
    // stable, so this reproduces the production adapter rather than reusing a
    // test wrapper that hid the leak.
    const raw = {};
    const opened = fakeSocket(raw);
    const messaged = fakeSocket(raw);
    const closed = fakeSocket(raw);
    s.handlers.onOpen(undefined as never, opened);
    s.handlers.onMessage(
      { data: JSON.stringify({ type: "activity_subscribe", view: "index" }) } as MessageEvent,
      messaged
    );
    await until(() => messaged.frames().some((f) => f.type === "activity_snapshot"));
    expect(s.stream.subscriptionCount()).toBe(1);

    s.handlers.onClose({ code: 1000, reason: "" } as CloseEvent, closed);
    expect(s.stream.subscriptionCount()).toBe(0);

    const before = messaged.frames().length;
    const cron = createActivityStore(s.db, { writer: "cron-test" });
    cron.startSpan({
      spanId: "cron-root-2",
      runId: "cron-run-2",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    s.stream.pump();
    expect(messaged.frames().length).toBe(before);
  });

  test("revocation drops only that principal's activity subscriptions", async () => {
    const s = setup(scriptedTurn());
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const revokedHandlers = createWsHandlers(s.host, testPrincipal("revoked"));
    const survivorHandlers = createWsHandlers(s.host, testPrincipal("survivor"));
    const revoked = fakeSocket();
    const survivor = fakeSocket();
    await revokedHandlers.onOpen(undefined as never, revoked);
    await survivorHandlers.onOpen(undefined as never, survivor);
    revokedHandlers.onMessage(
      { data: JSON.stringify({ type: "activity_subscribe", view: "index" }) } as MessageEvent,
      revoked
    );
    survivorHandlers.onMessage(
      { data: JSON.stringify({ type: "activity_subscribe", view: "index" }) } as MessageEvent,
      survivor
    );
    await until(() => s.stream.subscriptionCount() === 2);

    s.host.revokePrincipals(["revoked"], 1008, "Sessions invalidated");

    expect(s.stream.subscriptionCount()).toBe(1);
    const revokedFrameCount = revoked.frames().length;
    const survivorFrameCount = survivor.frames().length;
    const cron = createActivityStore(s.db, { writer: "cron-revocation-test" });
    cron.startSpan({
      spanId: "survivor-root",
      runId: "survivor-run",
      name: "survivor sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    s.stream.pump();

    expect(revoked.frames()).toHaveLength(revokedFrameCount);
    expect(survivor.frames()).toHaveLength(survivorFrameCount + 1);
    expect(survivor.frames().at(-1)).toEqual(
      expect.objectContaining({ type: "activity_delta", runId: "survivor-run" })
    );
  });

  test("a scoped subscribe without its scope id is ignored — no snapshot, no subscription", async () => {
    const s = setup(scriptedTurn());
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const ws = openAndSubscribe(s, { type: "activity_subscribe", view: "session" });
    openAndSubscribe(s, { type: "activity_subscribe", view: "run" });
    // Give the async handler path a beat, then confirm nothing registered.
    await new Promise((r) => setTimeout(r, 20));
    expect(s.stream.subscriptionCount()).toBe(0);
    expect(ws.frames().filter((f) => f.type === "activity_snapshot")).toHaveLength(0);
  });

  test("a turn abort cascades open spans to cancelled and the deltas reach subscribers", async () => {
    const s = setup(async ({ bridge, signal }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-1", isNew: true });
      bridge.emit({ type: "tool_use_start", toolUseId: "agent-1", toolName: "Agent" });
      bridge.emit({
        type: "tool_use_start",
        toolUseId: "sub-t1",
        toolName: "Read",
        parentToolUseId: "agent-1",
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    cleanup = () => {
      s.stream.close();
      s.db.close();
    };
    const ws = openAndSubscribe(s, {
      type: "activity_subscribe",
      view: "session",
      sessionId: "sess-1",
    });
    s.handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent,
      ws
    );
    await until(() => s.store.getSpan("sub-t1") !== null);
    // The subagent's tool span nests under the Agent call, which is a
    // subagent-kind span.
    expect(s.store.getSpan("sub-t1")!.parentSpanId).toBe("agent-1");
    expect(s.store.getSpan("agent-1")!.kind).toBe("subagent");

    s.handlers.onMessage(
      { data: JSON.stringify({ type: "cancel", sessionId: "sess-1" }) } as MessageEvent,
      ws
    );
    await until(() => s.store.openRootSpans().length === 0);
    expect(s.store.getSpan("agent-1")!.outcome).toBe("cancelled");
    expect(s.store.getSpan("sub-t1")!.outcome).toBe("cancelled");
    const root = s.store
      .changesSince(0)
      .find((c) => c.kind === "span" && c.span.kind === "turn");
    expect(root && s.store.getSpan((root as any).span.spanId)!.outcome).toBe("cancelled");
    await until(() =>
      ws.frames().some((f) => f.type === "activity_delta" && f.span?.spanId === "sub-t1" && f.span?.outcome === "cancelled")
    );
  });
});

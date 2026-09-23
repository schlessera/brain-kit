/**
 * An approval decision records the channel it arrived on (#113), and a
 * voice-attributed grant is refused (docs/decisions/voice-permission.md: the
 * voice channel may deny, it may never grant). The field is what makes a
 * voice grant in the record detectable as a bug, so the host must never write
 * one — the wire is not trusted to enforce policy.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BackendBridge, PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createUiDb } from "../src/db/client";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { BrainUiClient } from "@schlessera/brain-ui-sdk/client";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

function fakeSocket(): WSContext & { frames: () => any[] } {
  const sent: string[] = [];
  return {
    send: (data: string) => sent.push(data),
    frames: () => sent.map((s) => JSON.parse(s)),
  } as WSContext & { frames: () => any[] };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/**
 * A turn that raises one approval for `t1` and reports what the backend was
 * told. `decided` stays null while the request is pending.
 */
function setup() {
  const db = createUiDb(":memory:");
  const observability = createRecordingObservability();
  const store = createActivityStore(db, { writer: "server-test" });
  const stream = createActivityStream(store);
  const granted = new Set<string>();
  const state: { decided: PermissionDecision | null; finish: () => void } = {
    decided: null,
    finish: () => {},
  };
  const backend = makeFakeBackend({
    id: "fake",
    startTurn: async ({ bridge }: { bridge: BackendBridge }) => {
      bridge.emit({ type: "session_info", sessionId: "sess-channel", isNew: true });
      bridge.emit({ type: "tool_use_start", toolUseId: "t1", toolName: "Write" });
      state.decided = await bridge.requestPermission({
        toolUseId: "t1",
        toolName: "Write",
        input: { path: "/tmp/example" },
        kind: "tool",
      });
      await new Promise<void>((r) => (state.finish = r));
      bridge.emit({
        type: "result",
        sessionId: "sess-channel",
        outcome: "success",
        durationMs: 1,
        numTurns: 1,
        isError: false,
      });
    },
  });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    observability,
    activity: { store, stream },
    toolPermissions: { isAutoAllowed: (n) => granted.has(n), add: (n) => granted.add(n) },
  });
  const handlers = createWsHandlers(host, testPrincipal());
  const ws = fakeSocket();
  cleanup = () => {
    state.finish();
    host.coordinator.reset();
    host.close();
    stream.close();
    db.close();
  };

  async function open(): Promise<string> {
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "go" }) } as MessageEvent, ws);
    await until(() => ws.frames().some((f) => f.type === "tool_approval_request"));
    return ws.frames().find((f) => f.type === "tool_approval_request").turnId;
  }
  function send(frame: Record<string, unknown>) {
    handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
  }
  function decisions() {
    const span = store.getSpan("t1");
    if (!span) return [];
    return store
      .snapshotRun(span.runId)!
      .events.filter((e) => e.eventType === "approval_decision")
      .map((e) => e.payload);
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { host, handlers, observability, state, granted, open, send, decisions, settle };
}

describe("an approval decision records its channel", () => {
  test("a denial made by voice is accepted and stored with its channel", async () => {
    const s = setup();
    const turnId = await s.open();
    s.send({ type: "tool_denial", toolUseId: "t1", message: "Refused by voice", channel: "voice", turnId });
    await until(() => s.state.decided !== null);

    expect(s.state.decided!.behavior).toBe("deny");
    expect(s.decisions()).toEqual([
      { principalId: "test-principal", decision: "deny", requestKind: "tool", channel: "voice" },
    ]);
  });

  test("a grant made on the card is stored with its channel", async () => {
    const s = setup();
    const turnId = await s.open();
    s.send({ type: "tool_approval", toolUseId: "t1", always: true, channel: "card", turnId });
    await until(() => s.state.decided !== null);

    expect(s.state.decided!.behavior).toBe("allow");
    expect(s.decisions()).toEqual([
      { principalId: "test-principal", decision: "always_allow", requestKind: "tool", channel: "card" },
    ]);
    expect([...s.granted]).toEqual(["Write"]);
  });

  test("a grant attributed to voice is refused and the request stays pending", async () => {
    const s = setup();
    const turnId = await s.open();
    s.send({ type: "tool_approval", toolUseId: "t1", channel: "voice", turnId });
    s.send({ type: "tool_approval", toolUseId: "t1", always: true, channel: "voice", turnId });
    s.send({
      type: "tool_approval",
      toolUseId: "t1",
      updatedInput: { path: "/tmp/elsewhere" },
      channel: "voice",
      turnId,
    });
    await s.settle();

    // Not resolved, not recorded, not remembered: the card is still the only
    // surface that can grant, and it still can.
    expect(s.state.decided).toBeNull();
    expect(s.host.coordinator.pendingApprovals.has("t1")).toBe(true);
    expect(s.decisions()).toEqual([]);
    expect(s.granted.size).toBe(0);
    const refused = s.observability.logs
      .find({ scope: "ws" })
      .filter((r) => r.body === "voice-attributed grant refused");
    expect(refused).toHaveLength(3);
    expect(refused[0]!.severity).toBe("WARN");
    expect(refused[0]!.attributes["toolUse.id"]).toBe("t1");

    s.send({ type: "tool_approval", toolUseId: "t1", channel: "card", turnId });
    await until(() => s.state.decided !== null);
    expect(s.state.decided!.behavior).toBe("allow");
    expect(s.decisions()).toEqual([
      { principalId: "test-principal", decision: "allow", requestKind: "tool", channel: "card" },
    ]);
  });

  test("after a refused voice grant, the same client can still answer from the card", async () => {
    // A client ends the exchange when it replies: BrainUiClient drops the
    // request's turn correlation as it sends. If the host refused the reply
    // and said nothing, the card's answer would go out uncorrelated and a
    // rev-3+ host would drop it too — the request stuck until the turn budget.
    // The real client over the real handlers, so the echo rule is live.
    const s = setup();
    const seen: string[] = [];
    let server: WSContext | null = null;
    const client = new BrainUiClient({
      url: "ws://test/ws",
      handlers: { tool_approval_request: (m: { toolUseId: string }) => seen.push(m.toolUseId) } as never,
      socketFactory: () => {
        const sock = {
          readyState: 0,
          onopen: null as null | (() => void),
          onmessage: null as null | ((e: MessageEvent) => void),
          onclose: null,
          onerror: null,
          send: (data: string) => s.handlers.onMessage({ data } as MessageEvent, server!),
          close: () => {},
        };
        server = { send: (data: string) => sock.onmessage?.({ data } as MessageEvent) } as WSContext;
        queueMicrotask(async () => {
          await s.handlers.onOpen(undefined as never, server!);
          sock.readyState = 1;
          sock.onopen?.();
        });
        return sock as unknown as WebSocket;
      },
    });
    client.connect();
    await until(() => (server !== null && (client as unknown as { ws: { readyState: number } }).ws?.readyState === 1));
    client.send({ type: "chat_message", text: "go" });
    await until(() => seen.length === 1);

    client.send({ type: "tool_approval", toolUseId: "t1", channel: "voice" });
    await s.settle();
    expect(s.state.decided).toBeNull();

    client.send({ type: "tool_approval", toolUseId: "t1", channel: "card" });
    await until(() => s.state.decided !== null);
    expect(s.state.decided!.behavior).toBe("allow");
    expect(s.decisions()).toEqual([
      { principalId: "test-principal", decision: "allow", requestKind: "tool", channel: "card" },
    ]);
    // It got there because the refusal handed the card back.
    expect(seen).toEqual(["t1", "t1"]);
    client.close();
  });
});

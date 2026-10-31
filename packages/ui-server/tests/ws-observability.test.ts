/**
 * The loop closed: drive the REAL inbound-frame path, then read what the
 * server reported back out through the consumer APIs.
 *
 * This is the shape every future instrumentation test should take. No stdout
 * scraping, no re-implementation of the handler — `createWsHandlers(host)` is
 * exactly what `createWsUpgrade` hands to Hono in production, and the only
 * thing the test changes is where the reports land.
 *
 * Before this instrumentation existed, every assertion below was unobservable:
 * `parseClientMessage` rejections answered the client and vanished, and a
 * handler that threw sent a generic frame while discarding the cause.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createBunWebSocket } from "hono/bun";
import { Hono } from "hono";

import { BackendBusyError } from "@schlessera/brain-ui-sdk/server";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { resolveServerConfig } from "../src/config/env";
import { createUiDb } from "../src/db/client";
import { resolveAmbientPrincipal } from "../src/db/principals";
import { createTestApp } from "./helpers/test-app";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers as createAuthorizedWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

const createWsHandlers = (host: WsHost) =>
  createAuthorizedWsHandlers(host, testPrincipal());

/** A socket that records what the server sent it. */
interface FakeSocket extends WSContext {
  sent: string[];
  closed: Array<{ code: number; reason: string }>;
}

function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  return {
    send: (data: string) => sent.push(data),
    close: (code: number, reason: string) => closed.push({ code, reason }),
    readyState: 1,
    sent,
    closed,
  } as unknown as FakeSocket;
}

function bunAdapterSocket(events: ReturnType<typeof createWsHandlers>) {
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    send() {},
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
    data: {
      events,
      url: new URL("http://example.test/ws"),
      protocol: "",
    },
    readyState: 1 as const,
    closed,
  };
}

function setup(wsMaxConnections?: number) {
  const db = createUiDb(":memory:");
  const observability = createRecordingObservability();
  const backend = makeFakeBackend({ id: "fake" });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    observability,
    ...(wsMaxConnections === undefined ? {} : { wsMaxConnections }),
  });
  return { db, host, observability, handlers: createWsHandlers(host) };
}

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

describe("inbound frame rejections are observable", () => {
  test("a malformed frame is counted, logged, and answered", () => {
    const { db, host, observability, handlers } = setup();
    close = () => db.close();
    const ws = fakeSocket();

    handlers.onMessage({ data: "{not json" } as MessageEvent, ws);

    // 1. The client is told — unchanged behaviour.
    expect(ws.sent.length).toBe(1);
    expect(JSON.parse(ws.sent[0]).code).toBe("PARSE_ERROR");

    // 2. The counter moved, which is what /api/status surfaces.
    expect(
      observability.metrics.value("ws.frames.dropped", {
        reason: "parse_error",
        direction: "inbound",
      })
    ).toBe(1);

    // 3. A log record exists, at WARN, scoped to [ws].
    const [record] = observability.logs.find({ scope: "ws", severity: "WARN" });
    expect(record.body).toBe("inbound frame rejected");
    expect(record.attributes.reason).toBe("parse_error");

    void host;
  });

  test("a binary frame is counted under its own reason", () => {
    const { db, observability, handlers } = setup();
    close = () => db.close();

    handlers.onMessage({ data: new ArrayBuffer(8) } as MessageEvent, fakeSocket());

    expect(
      observability.metrics.value("ws.frames.dropped", {
        reason: "binary_frame",
        direction: "inbound",
      })
    ).toBe(1);
    // Distinct series, so /api/status distinguishes a confused client from a
    // hostile one rather than lumping them into one number.
    expect(observability.metrics.total("ws.frames.dropped")).toBe(1);
  });

  test("the reported detail never contains the frame body", () => {
    const { db, observability, handlers } = setup();
    close = () => db.close();

    // A caller-supplied payload can be 12 MB; logging it would be the bug.
    const secret = "SHOULD-NOT-BE-LOGGED-" + "x".repeat(500);
    handlers.onMessage({ data: `{"type":"chat_message","content":"${secret}"` } as MessageEvent, fakeSocket());

    const records = observability.logs.find({ body: "inbound frame rejected" });
    expect(records).toHaveLength(1);
    expect(records[0]!.attributes.detail).toBeString();
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("SHOULD-NOT-BE-LOGGED");
    expect(observability.metrics.total("ws.frames.dropped")).toBe(1);
  });

  test("counts accumulate across frames and split by reason", () => {
    const { db, observability, handlers } = setup();
    close = () => db.close();
    const ws = fakeSocket();

    handlers.onMessage({ data: "{oops" } as MessageEvent, ws);
    handlers.onMessage({ data: "{oops again" } as MessageEvent, ws);
    handlers.onMessage({ data: new ArrayBuffer(4) } as MessageEvent, ws);

    expect(observability.metrics.total("ws.frames.dropped")).toBe(3);
    expect(
      observability.metrics.value("ws.frames.dropped", {
        reason: "parse_error",
        direction: "inbound",
      })
    ).toBe(2);
    expect(observability.logs.count({ body: "inbound frame rejected" })).toBe(3);
  });

  test("a valid frame reports nothing", () => {
    const { db, observability, handlers } = setup();
    close = () => db.close();

    handlers.onMessage(
      { data: JSON.stringify({ type: "cancel", sessionId: "s1" }) } as MessageEvent,
      fakeSocket()
    );

    // No drop counter, and no WARN — instrumentation that fires on the happy
    // path is worse than none, because it trains you to ignore it.
    expect(observability.metrics.total("ws.frames.dropped")).toBe(0);
    expect(observability.logs.count({ minSeverity: "WARN" })).toBe(0);
  });
});

describe("the snapshot /api/status serves", () => {
  test("carries the recorded series, JSON-safe", async () => {
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({ id: "fake" });
    const rig = await createTestApp({ appOptions: {
      registry: createStaticBackendRegistry([backend], backend.id), observability,
    } });
    try {
      const principal = resolveAmbientPrincipal(rig.app.db, "none", "No authentication", "No authentication");
      const handlers = createAuthorizedWsHandlers(rig.app.wsHost, principal);
      handlers.onMessage({ data: "{bad" } as MessageEvent, fakeSocket());
      const response = await rig.fetch("/api/status");
      expect(response.status).toBe(200);
      const snapshot = (await response.json()).metrics;
      expect(snapshot).toEqual([
        {
          name: "ws.frames.dropped",
          attributes: { direction: "inbound", reason: "parse_error" },
          value: 1,
          kind: "counter",
        },
      ]);
    } finally { await rig.teardown(); }
  });
});

describe("connection admission is observable", () => {
  test("a sequential reconnect frees capacity through Hono's Bun adapter", () => {
    const { db, host } = setup(1);
    close = () => db.close();
    const { websocket: bunWebSocket } = createBunWebSocket();
    const first = bunAdapterSocket(createWsHandlers(host));

    bunWebSocket.open(first);
    bunWebSocket.close(first, 1000, "normal closure");

    const second = bunAdapterSocket(createWsHandlers(host));
    bunWebSocket.open(second);

    expect(second.closed).toEqual([]);
    expect(host.clients.count()).toBe(1);
  });

  test("the 33rd connection is closed and reported at the default cap", async () => {
    const config = resolveServerConfig({});
    const { db, host, observability } = setup(config.wsMaxConnections);
    close = () => db.close();
    const sockets = Array.from({ length: 33 }, () => fakeSocket());

    for (const ws of sockets) {
      await createWsHandlers(host).onOpen({} as Event, ws);
    }

    expect(host.clients.count()).toBe(32);
    expect(sockets.slice(0, 32).every((ws) => ws.closed.length === 0)).toBe(true);
    expect(sockets[32].closed).toEqual([
      { code: 4008, reason: "Connection limit reached" },
    ]);
    expect(
      observability.metrics.value("ws.connections.refused", {
        reason: "connection_limit",
      })
    ).toBe(1);
    const [record] = observability.logs.find({ body: "websocket connection refused" });
    expect(record.severity).toBe("WARN");
    expect(record.attributes).toEqual({
      reason: "connection_limit",
      "connection.limit": 32,
    });
  });

  test("BRAIN_UI_WS_MAX_CONNECTIONS honours a lower cap", async () => {
    const config = resolveServerConfig({ BRAIN_UI_WS_MAX_CONNECTIONS: "2" });
    const { db, host } = setup(config.wsMaxConnections);
    close = () => db.close();
    const sockets = Array.from({ length: 3 }, () => fakeSocket());

    for (const ws of sockets) {
      await createWsHandlers(host).onOpen({} as Event, ws);
    }

    expect(host.clients.count()).toBe(2);
    expect(sockets[2].closed).toEqual([
      { code: 4008, reason: "Connection limit reached" },
    ]);
  });
});

/** Poll until `cond` holds — runSession is fired without an awaitable handle. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(cond()).toBe(true);
}

const chat = (text: string, sessionId?: string) =>
  ({ data: JSON.stringify({ type: "chat_message", text, ...(sessionId ? { sessionId } : {}) }) }) as MessageEvent;

describe("turn lifecycle is observable", () => {
  test("a successful turn is counted and logged with its correlation ids", async () => {
    const db = createUiDb(":memory:");
    close = () => db.close();
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (req) => {
        req.bridge.emit({ type: "session_info", sessionId: "s1", isNew: true });
        req.bridge.emit({
          type: "result",
          sessionId: "s1",
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
    });
    const handlers = createWsHandlers(host);

    handlers.onMessage(chat("hi"), fakeSocket());
    await until(() => observability.metrics.total("turns.completed") === 1);

    expect(observability.metrics.total("turns.started")).toBe(1);
    expect(observability.metrics.total("turns.failed")).toBe(0);

    const [started] = observability.logs.find({ body: "turn started" });
    expect(started.severity).toBe("INFO");
    expect(started.attributes["turn.id"]).toBeString();

    // session_info resolved the session before the turn finished, so the
    // completion record can carry it.
    const [completed] = observability.logs.find({ body: "turn completed" });
    expect(completed.attributes["session.id"]).toBe("s1");
    expect(completed.attributes["turn.id"]).toBe(started.attributes["turn.id"]);
    expect(completed.attributes["duration.ms"]).toBeNumber();
  });

  test("a resolved turn whose terminal result is an error counts as failed", async () => {
    // Both bundled backends RESOLVE startTurn on runtime failure and report it
    // on the result frame — accounting must read the frame, not the resolve.
    const db = createUiDb(":memory:");
    close = () => db.close();
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (req) => {
        req.bridge.emit({ type: "session_info", sessionId: "s1", isNew: true });
        req.bridge.emit({ type: "error", code: "agent_error", message: "no credentials" });
        req.bridge.emit({
          type: "result",
          sessionId: "s1",
          outcome: "error",
          durationMs: 1,
          numTurns: 1,
          isError: true,
        });
      },
    });
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      observability,
    });
    createWsHandlers(host).onMessage(chat("hi"), fakeSocket());

    await until(
      () => observability.metrics.value("turns.failed", { code: "BACKEND_RESULT_ERROR" }) === 1
    );
    expect(observability.metrics.total("turns.completed")).toBe(0);
    const [failed] = observability.logs.find({ body: "turn failed" });
    expect(failed.severity).toBe("ERROR");
    expect(failed.attributes["session.id"]).toBe("s1");
  });

  test("a backend crash is an ERROR record and a turns.failed count by code", async () => {
    const db = createUiDb(":memory:");
    close = () => db.close();
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async () => {
        throw new Error("model exploded");
      },
    });
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      observability,
    });
    createWsHandlers(host).onMessage(chat("hi"), fakeSocket());

    await until(() => observability.metrics.value("turns.failed", { code: "BACKEND_ERROR" }) === 1);
    expect(observability.metrics.total("turns.completed")).toBe(0);

    const [failed] = observability.logs.find({ body: "turn failed" });
    expect(failed.severity).toBe("ERROR");
    expect(failed.attributes.code).toBe("BACKEND_ERROR");
    expect(failed.attributes.error).toBe("model exploded");
  });

  test("a busy session is WARN, not ERROR", async () => {
    const db = createUiDb(":memory:");
    close = () => db.close();
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async () => {
        throw new BackendBusyError("fake", "s1");
      },
    });
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      observability,
    });
    createWsHandlers(host).onMessage(chat("hi"), fakeSocket());

    await until(() => observability.metrics.value("turns.failed", { code: "SESSION_BUSY" }) === 1);
    const [failed] = observability.logs.find({ body: "turn failed" });
    expect(failed.severity).toBe("WARN");
  });

  test("a routing failure before any turn is minted still lands in the record", async () => {
    const db = createUiDb(":memory:");
    close = () => db.close();
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({ id: "fake" });
    backend.listProfiles = () => {
      throw new Error("roster unavailable");
    };
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      observability,
    });
    createWsHandlers(host).onMessage(chat("hi", "s7"), fakeSocket());

    await until(() => observability.metrics.value("turns.failed", { code: "BACKEND_ERROR" }) === 1);
    const [failed] = observability.logs.find({ body: "turn failed" });
    // No turn.id: routing threw before one existed. The session identity the
    // client asked for is still on the record.
    expect(failed.attributes["session.id"]).toBe("s7");
    expect(failed.attributes["turn.id"]).toBeUndefined();
  });

  test("a rejected follow-up is recorded against the running turn", async () => {
    const db = createUiDb(":memory:");
    close = () => db.close();
    const observability = createRecordingObservability();
    let finishTurn!: () => void;
    const backend = makeFakeBackend({
      id: "fake",
      capabilities: { followUp: true },
      startTurn: async (req) => {
        req.bridge.emit({ type: "session_info", sessionId: "s1", isNew: true });
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
      },
      followUp: async () => {
        throw new Error("injection refused");
      },
    });
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      observability,
    });
    const handlers = createWsHandlers(host);

    handlers.onMessage(chat("hi"), fakeSocket());
    await until(() => host.coordinator.bySession.has("s1"));
    handlers.onMessage(chat("and another thing", "s1"), fakeSocket());

    await until(
      () => observability.metrics.value("turns.failed", { code: "FOLLOWUP_FAILED" }) === 1
    );
    const [failed] = observability.logs.find({ body: "turn failed" });
    expect(failed.attributes["session.id"]).toBe("s1");
    expect(failed.attributes.error).toBe("injection refused");

    finishTurn();
    await until(() => observability.metrics.total("turns.completed") === 1);
  });

  test("a failed session load is recorded under its own code", async () => {
    const db = createUiDb(":memory:");
    close = () => db.close();
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({ id: "fake" });
    const sessionId = "odysseus-ithaca";
    const catalog = createSessionCatalog(() => db);
    catalog.persistSessionStub(sessionId, "Odysseus plans the voyage.", null, backend.id);
    await catalog.settled?.();
    expect(catalog.hasSession!(sessionId), "KNOWN_CHAT_EXISTS_BEFORE_INDUCED_HISTORY_FAILURE").toBe(true);
    let reads = 0;
    backend.getHistory = async () => {
      reads++;
      throw new Error("transcript unreadable");
    };
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog,
      observability,
    });
    const socket = fakeSocket();
    createWsHandlers(host).onMessage(
      { data: JSON.stringify({ type: "session_resume", sessionId }) } as MessageEvent,
      socket
    );

    await until(
      () => observability.metrics.value("turns.failed", { code: "SESSION_LOAD_ERROR" }) === 1
    );
    expect(reads, "KNOWN_CHAT_REACHES_ITS_HISTORY_READER").toBe(1);
    expect(socket.sent.map(raw => JSON.parse(raw))).toContainEqual({
      type: "error", code: "SESSION_LOAD_ERROR", sessionId, message: "The host could not load this conversation. No work was started; your draft is kept.",
    });
    const [failed] = observability.logs.find({ body: "turn failed" });
    expect(failed.attributes["session.id"]).toBe(sessionId);
    expect(failed.attributes.error).toBe("transcript unreadable");
    // #1328: the resume itself is one line, with its outcome.
    const resumes = observability.logs.find({ body: "session resume" });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.attributes).toMatchObject({ "session.id": sessionId, outcome: "error", error: "transcript unreadable" });
  });

  test("native socket distinguishes a known history failure from a genuinely missing chat", async () => {
    const db = createUiDb(":memory:");
    const observability = createRecordingObservability();
    const sessionId = "odysseus-ithaca", missingId = "odysseus-missing";
    const reads: string[] = [];
    const backend = makeFakeBackend({ id: "fake", getHistory: async id => {
      reads.push(id);
      if (id === sessionId) throw new Error("transcript unreadable");
      return [];
    } });
    const catalog = createSessionCatalog(() => db);
    catalog.persistSessionStub(sessionId, "Odysseus plans the voyage.", null, backend.id);
    await catalog.settled?.();
    expect(catalog.hasSession!(sessionId), "SOCKET_FIXTURE_KNOWN_CHAT_IS_REGISTERED").toBe(true);
    expect(catalog.hasSession!(missingId), "SOCKET_FIXTURE_MISSING_CHAT_IS_ABSENT").toBe(false);
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog, observability });
    const { upgradeWebSocket, websocket } = createBunWebSocket();
    const app = new Hono(); app.get("/ws", upgradeWebSocket(() => createWsHandlers(host)));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const frames: Array<{ type: string; code?: string; sessionId?: string; message?: string }> = [];
    socket.onmessage = event => { frames.push(JSON.parse(String(event.data))); };
    const closed = new Promise<void>(resolve => { socket.onclose = () => resolve(); });
    try {
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Odysseus fixture socket failed")); });
      socket.send(JSON.stringify({ type: "session_resume", sessionId }));
      await until(() => frames.some(frame => frame.type === "error" && frame.sessionId === sessionId));
      expect(frames.find(frame => frame.type === "error" && frame.sessionId === sessionId), "KNOWN_HISTORY_FAILURE_KEEPS_ITS_ERROR_CODE").toMatchObject({ code: "SESSION_LOAD_ERROR", message: "The host could not load this conversation. No work was started; your draft is kept." });
      expect(observability.metrics.value("turns.failed", { code: "SESSION_LOAD_ERROR" }), "SOCKET_HISTORY_FAILURE_RECORDS_ORIGINAL_METRIC").toBe(1);
      socket.send(JSON.stringify({ type: "session_resume", sessionId: missingId }));
      await until(() => frames.some(frame => frame.type === "error" && frame.sessionId === missingId));
      expect(frames.find(frame => frame.type === "error" && frame.sessionId === missingId), "MISSING_CHAT_IS_NOT_A_KNOWN_HISTORY_LOAD_FAILURE").toMatchObject({ code: "SESSION_NOT_FOUND" });
      expect(observability.metrics.total("turns.failed"), "MISSING_REFUSAL_ADDS_NO_KNOWN_LOAD_FAILURE").toBe(1);
      expect(observability.logs.find({ body: "turn failed" })).toHaveLength(1);
      expect(observability.logs.find({ body: "session resume" })).toHaveLength(2);
      expect(frames.some(frame => frame.type === "session_info" && frame.sessionId === missingId)).toBe(false);
      expect(catalog.hasSession!(missingId), "REFUSAL_NEVER_CREATES_THE_MISSING_CHAT").toBe(false);
      expect(reads).toEqual([sessionId, missingId]);
    } finally {
      socket.close(); server.stop(true); await closed; host.close(); db.close();
    }
  });

  test.each(["registered", "imported-failure", "imported-publication-failure", "imported-success", "absent"] as const)(
    "native resume preserves cause, accounting and admission: %s (#3194)", async kind => {
      const db = createUiDb(":memory:");
      const observability = createRecordingObservability();
      const sessionId = "odysseus-ithaca";
      const diagnostic = "Odysseus transcript unreadable: /private/transcript.json";
      const history = [{ role: "user" as const, content: "Is the raft lashed?", toolCalls: [] }];
      let reads = 0, starts = 0;
      const backend = makeFakeBackend({ id: "fake", getHistory: async () => {
        reads++;
        if (kind === "registered" || kind === "imported-failure" || (kind === "imported-publication-failure" && reads > 1)) throw new Error(diagnostic);
        return kind === "imported-success" || kind === "imported-publication-failure" ? history : [];
      }, startTurn: async () => { starts++; } });
      const catalog = createSessionCatalog(() => db);
      if (kind === "registered") {
        catalog.persistSessionStub(sessionId, "Odysseus plans the voyage.", null, backend.id);
        await catalog.settled?.();
      }
      const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog, observability });
      const { upgradeWebSocket, websocket } = createBunWebSocket();
      const app = new Hono(); app.get("/ws", upgradeWebSocket(() => createWsHandlers(host)));
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const frames: Array<{ type: string; code?: string; sessionId?: string; message?: string }> = [];
      socket.onmessage = event => { frames.push(JSON.parse(String(event.data))); };
      const closed = new Promise<void>(resolve => { socket.onclose = () => resolve(); });
      try {
        await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Odysseus fixture socket failed")); });
        socket.send(JSON.stringify({ type: "session_resume", sessionId }));
        await until(() => frames.some(frame => frame.sessionId === sessionId && (frame.type === "error" || frame.type === "status")));
        const failed = kind === "registered" || kind === "imported-failure" || kind === "imported-publication-failure";
        const resumes = observability.logs.find({ body: "session resume" });
        expect(resumes, "ONE_RESUME_OUTCOME").toHaveLength(1);
        expect(resumes[0]!.attributes).toMatchObject({ "session.id": sessionId, outcome: kind === "imported-success" ? "loaded" : "error" });
        if (failed) {
          expect(resumes[0]!.attributes.error, "HISTORY_FAILURE_RETAINS_ORIGINAL_CAUSE").toBe(diagnostic);
          expect(observability.metrics.value("turns.failed", { code: "SESSION_LOAD_ERROR" }), "HISTORY_FAILURE_COUNTS_EXACTLY_ONCE").toBe(1);
          expect(observability.logs.find({ body: "turn failed" })).toHaveLength(1);
          expect(observability.logs.find({ body: "turn failed" })[0]!.attributes.error).toBe(diagnostic);
          expect(frames.filter(frame => frame.type === "error")).toHaveLength(1);
          expect(frames.find(frame => frame.type === "error")).toMatchObject({ code: "SESSION_LOAD_ERROR", sessionId });
          expect(JSON.stringify(frames), "CLIENT_NEVER_RECEIVES_RAW_DIAGNOSTIC").not.toContain(diagnostic);
        } else {
          expect(observability.metrics.total("turns.failed")).toBe(0);
          expect(observability.logs.find({ body: "turn failed" })).toHaveLength(0);
        }
        if (kind === "imported-success") {
          expect(frames.some(frame => frame.type === "session_info" && frame.sessionId === sessionId)).toBe(true);
          expect(frames.some(frame => frame.type === "session_history" && frame.sessionId === sessionId)).toBe(true);
        } else {
          expect(frames.some(frame => frame.type === "session_history")).toBe(false);
          if (kind === "imported-failure" || kind === "absent") expect(frames.some(frame => frame.type === "session_info")).toBe(false);
          if (kind === "absent") expect(frames.find(frame => frame.type === "error")).toMatchObject({ code: "SESSION_NOT_FOUND" });
        }
        expect(reads).toBe(kind === "imported-success" || kind === "imported-publication-failure" ? 2 : 1);
        expect(starts, "RESUME_NEVER_STARTS_WORK").toBe(0);
        expect(host.coordinator.bySession.size).toBe(0);
        expect(host.coordinator.startingBySession.size).toBe(0);
        expect(catalog.hasSession!(sessionId), "LOOKUP_NEVER_INVENTS_CATALOG_OWNERSHIP").toBe(kind === "registered");
      } finally {
        socket.close(); server.stop(true); await closed; host.close(); db.close();
      }
    }
  );

  test.each(["closing", "disconnect", "revoked", "expired", "principal-invalid"] as const)(
    "native delayed imported lookup preserves the %s fence (#3194)", async fence => {
      const db = createUiDb(":memory:");
      const observability = createRecordingObservability();
      const sessionId = "odysseus-ithaca";
      let rejectRead!: (error: Error) => void;
      const read = new Promise<never>((_, reject) => { rejectRead = reject; });
      let reads = 0, starts = 0, valid = true;
      const principal = { ...testPrincipal(), expiresAt: Date.now() + 60_000 };
      const backend = makeFakeBackend({ id: "fake", getHistory: async () => { reads++; return read; }, startTurn: async () => { starts++; } });
      const catalog = createSessionCatalog(() => db);
      const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog, observability, isPrincipalValid: () => valid });
      const { upgradeWebSocket, websocket } = createBunWebSocket();
      const app = new Hono(); app.get("/ws", upgradeWebSocket(() => createAuthorizedWsHandlers(host, principal)));
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const frames: Array<{ type: string; sessionId?: string }> = [];
      socket.onmessage = event => { frames.push(JSON.parse(String(event.data))); };
      const closed = new Promise<void>(resolve => { socket.onclose = () => resolve(); });
      try {
        await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Odysseus fixture socket failed")); });
        socket.send(JSON.stringify({ type: "session_resume", sessionId }));
        await until(() => reads === 1);
        if (fence === "closing") await host.close();
        if (fence === "disconnect") { socket.close(); await closed; }
        if (fence === "revoked") await host.revokePrincipals([principal.id], 1008, "Session revoked");
        if (fence === "expired") host.expireAuthorizationContexts(principal.expiresAt + 1);
        if (fence === "principal-invalid") valid = false;
        rejectRead(new Error("Odysseus delayed transcript diagnostic"));
        await until(() => observability.logs.find({ body: "session resume" }).length === 1);
        expect(observability.metrics.total("turns.failed"), "STALE_LOOKUP_IS_NOT_A_LOAD_FAILURE").toBe(0);
        expect(observability.logs.find({ body: "turn failed" })).toHaveLength(0);
        expect(JSON.stringify(observability.logs.find({ body: "session resume" }))).not.toContain("Odysseus delayed transcript diagnostic");
        expect(frames.filter(frame => frame.sessionId === sessionId), "NO_STALE_PUBLICATION").toEqual([]);
        expect(starts).toBe(0);
        expect(catalog.hasSession!(sessionId)).toBe(false);
      } finally {
        socket.close(); server.stop(true); await closed; await host.close(); db.close();
      }
    }
  );

  test("a loaded session resume logs one line with its session and outcome (#1328)", async () => {
    const db = createUiDb(":memory:");
    close = () => db.close();
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({ id: "fake" });
    backend.getHistory = async () => [
      { role: "user", content: "Is the raft lashed?", toolCalls: [] },
      { role: "assistant", content: "Calypso checked every knot.", toolCalls: [] },
    ];
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      observability,
    });
    const socket = fakeSocket();
    createWsHandlers(host).onMessage(
      { data: JSON.stringify({ type: "session_resume", sessionId: "ogygia" }) } as MessageEvent,
      socket
    );

    await until(() => socket.sent.some((raw) => JSON.parse(raw).type === "status"));
    const resumes = observability.logs.find({ body: "session resume" });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.severity).toBe("INFO");
    expect(resumes[0]!.attributes).toMatchObject({ "session.id": "ogygia", outcome: "loaded", "history.messages": 2 });
  });
});

describe("socket-level failures are observable", () => {
  test("an abnormal close code is counted and logged", () => {
    // hono's Bun adapter never dispatches onError — a transport failure is
    // only visible as a close with an abnormal code, so that is what reports.
    const { db, observability, handlers } = setup();
    close = () => db.close();

    handlers.onClose({ code: 1006 } as CloseEvent, fakeSocket());

    expect(observability.metrics.value("ws.errors", { "close.code": 1006 })).toBe(1);
    const [record] = observability.logs.find({ body: "websocket closed abnormally" });
    expect(record.severity).toBe("WARN");
    expect(record.attributes["close.code"]).toBe(1006);
  });

  test("the two clean close codes report nothing", () => {
    const { db, observability, handlers } = setup();
    close = () => db.close();

    handlers.onClose({ code: 1000 } as CloseEvent, fakeSocket());
    handlers.onClose({ code: 1001 } as CloseEvent, fakeSocket());

    expect(observability.metrics.total("ws.errors")).toBe(0);
    expect(observability.logs.count({ minSeverity: "WARN" })).toBe(0);
  });

  test("a dropped raw send (Bun status 0) is counted; backpressure is not", () => {
    // Bun's ServerWebSocket.send RETURNS its status instead of throwing —
    // 0 means the connection is closed and the frame was dropped, -1 means
    // backpressure queued it. Only the drop is a lost frame.
    const { db, host, observability } = setup();
    close = () => db.close();
    const dead = fakeSocket();
    dead.raw = { send: () => 0 };
    const congested = fakeSocket();
    congested.raw = { send: () => -1 };
    host.clients.add(dead, "test-principal");
    host.clients.add(congested, "test-principal");

    host.sendToClients({ type: "status", status: "idle" });

    expect(
      observability.metrics.value("ws.frames.dropped", {
        reason: "broadcast_send_failed",
        direction: "outbound",
      })
    ).toBe(1);
  });

  test("a broadcast send failure lands on the dropped-frame counter, outbound", () => {
    const { db, host, observability } = setup();
    close = () => db.close();
    const dead = fakeSocket();
    dead.send = () => {
      throw new Error("socket is gone");
    };
    const live = fakeSocket();
    host.clients.add(dead, "test-principal");
    host.clients.add(live, "test-principal");

    host.sendToClients({ type: "status", status: "idle" });

    // The live peer still got the frame; the dead one became a count.
    expect(live.sent.length).toBe(1);
    expect(
      observability.metrics.value("ws.frames.dropped", {
        reason: "broadcast_send_failed",
        direction: "outbound",
      })
    ).toBe(1);
  });
});

describe("session persistence failures are observable", () => {
  test("a failed catalog write warns with the session id instead of vanishing", async () => {
    const observability = createRecordingObservability();
    const db = createUiDb(":memory:");
    db.close();
    const catalog = createSessionCatalog(() => db, observability.logger("db"));

    // Still non-throwing — the turn must survive — but no longer silent.
    expect(() => catalog.persistSessionStub("s9", "prompt", null, "fake")).not.toThrow();
    // The write settles off the event loop (#2850); its failure is reported then.
    await catalog.settled!();

    const [record] = observability.logs.find({ scope: "db", severity: "WARN" });
    expect(record.body).toBe("session persistence failed");
    expect(record.attributes["session.id"]).toBe("s9");
  });
});

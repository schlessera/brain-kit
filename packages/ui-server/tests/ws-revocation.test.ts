import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { serializeSigned } from "hono/utils/cookie";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createApp } from "../src/app";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream, type ActivityStream } from "../src/activity/stream";
import { resolveServerConfig } from "../src/config/env";
import { createUiDb } from "../src/db/client";
import {
  createPrincipal,
  resolvePrincipal,
  revokePrincipal,
} from "../src/db/principals";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { handleChatMessage, runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import type { RunningTurn } from "../src/ws/turns";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

function fakeSocket() {
  const sent: string[] = [];
  const closed: Array<[number | undefined, string | undefined]> = [];
  const ws: WSContext = {
    send: (data) => sent.push(data),
    close: (code, reason) => closed.push([code, reason]),
  };
  return { ws, sent, closed };
}

const databases: ReturnType<typeof createUiDb>[] = [];
const activityStreams: ActivityStream[] = [];
const hosts: WsHost[] = [];

function hostFor(backend = makeFakeBackend({ id: "fake" })) {
  const db = createUiDb(":memory:");
  databases.push(db);
  const observability = createRecordingObservability();
  const registry = createStaticBackendRegistry([backend], backend.id);
  const host = new WsHost({
    registry,
    catalog: createSessionCatalog(() => db),
    observability,
  });
  hosts.push(host);
  return { host, registry, observability };
}

function activityHostFor(backend = makeFakeBackend({ id: "fake" })) {
  const db = createUiDb(":memory:");
  databases.push(db);
  const store = createActivityStore(db, { writer: "revocation-test" });
  const stream = createActivityStream(store);
  activityStreams.push(stream);
  const observability = createRecordingObservability();
  const registry = createStaticBackendRegistry([backend], backend.id);
  const host = new WsHost({
    registry,
    catalog: createSessionCatalog(() => db),
    observability,
    activity: { store, stream },
  });
  hosts.push(host);
  return { host, registry, observability, store };
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    // Construction registration plus scenario-specific revocation assertions
    // catch missing retains; this empty-registry invariant catches missing
    // releases. Together they replace every call site's old obligation to
    // "remember to register" correctly.
    expect(host.coordinator.authorizationRegistry.size).toBe(0);
    host.close();
  }
  for (const stream of activityStreams.splice(0)) stream.close();
  for (const db of databases.splice(0)) db.close();
});

describe("principal revocation boundary", () => {
  test("a frame arriving after revocation is refused before dispatch", async () => {
    let starts = 0;
    const { host, observability } = hostFor(
      makeFakeBackend({
        id: "fake",
        startTurn: async () => {
          starts += 1;
        },
      })
    );
    const handlers = createWsHandlers(host, testPrincipal("revoked"));
    const socket = fakeSocket();
    await handlers.onOpen({} as Event, socket.ws);

    host.revokePrincipals(["revoked"], 1008, "Sessions invalidated");
    handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "too late" }) } as MessageEvent,
      socket.ws
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(starts).toBe(0);
    expect(socket.closed).toEqual([[1008, "Sessions invalidated"]]);
    expect(
      observability.metrics.value("ws.frames.dropped", {
        reason: "revoked_principal",
        direction: "inbound",
      })
    ).toBe(1);
  });

  test("revocation between handler creation and socket admission refuses the stale socket", async () => {
    let starts = 0;
    const { host } = hostFor(
      makeFakeBackend({
        id: "fake",
        startTurn: async () => {
          starts += 1;
        },
      })
    );
    const handlers = createWsHandlers(host, testPrincipal("revoked"));
    const socket = fakeSocket();

    expect(host.coordinator.authorizationRegistry.size).toBe(1);
    host.revokePrincipals(["revoked"], 1008, "Sessions invalidated");
    await handlers.onOpen({} as Event, socket.ws);
    handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "too late" }) } as MessageEvent,
      socket.ws
    );
    await Promise.resolve();

    expect(starts).toBe(0);
    expect(socket.closed).toEqual([[1008, "Sessions invalidated"]]);
    expect(host.clients.count()).toBe(0);
    expect(host.coordinator.authorizationRegistry.size).toBe(0);
  });

  test("revocation after authentication but before handler creation is rechecked on the real route", async () => {
    const secret = "test-cookie-secret-0123456789abcdef";
    let starts = 0;
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async () => {
        starts += 1;
      },
    });
    const app = createApp({
      config: resolveServerConfig({
        AUTH_MODE: "password",
        BRAIN_UI_PASSWORD_HASH: "test-password-hash",
        COOKIE_SECRET: secret,
        HOST: "127.0.0.1",
        DB_PATH: ":memory:",
        BRAIN_PATH: "/tmp/brain-ws-revocation-route-test",
        BRAIN_UI_MODEL_DISCOVERY: "0",
        BRAIN_UI_PRICING_DISCOVERY: "0",
      }),
      registry: createStaticBackendRegistry([backend], backend.id),
    });

    try {
      const principal = createPrincipal(app.db, {
        authMethod: "password",
        label: "Test device",
        ttlSeconds: 3_600,
      });
      const cookie = await serializeSigned("brain_ui_session", principal.id, secret);
      const originalPrepare = app.db.prepare.bind(app.db);
      let revokedDuringTouch = false;
      app.db.prepare = ((sql: string) => {
        const statement = originalPrepare(sql);
        if (!sql.includes("UPDATE principals SET last_seen_at")) return statement;
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property === "run") {
              return (...args: unknown[]) => {
                const result = Reflect.apply(target.run, target, args);
                if (!revokedDuringTouch) {
                  revokedDuringTouch = true;
                  const ids = revokePrincipal(app.db, principal.id, Date.now());
                  app.wsHost.revokePrincipals(ids, 1008, "Sessions invalidated");
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as typeof app.db.prepare;

      let upgradeData: unknown;
      const response = await app.fetch(
        new Request("http://localhost/ws", {
          headers: {
            connection: "Upgrade",
            cookie,
            host: "localhost",
            origin: "http://localhost",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
            upgrade: "websocket",
          },
        }),
        {
          server: {
            upgrade(_request: Request, options: unknown) {
              upgradeData = (options as { data: unknown }).data;
              return true;
            },
          },
        }
      );
      expect(response.status).toBe(200);
      expect(revokedDuringTouch).toBe(true);
      expect(resolvePrincipal(app.db, principal.id)?.revokedAt).not.toBeNull();

      const sent: string[] = [];
      const closed: Array<[number | undefined, string | undefined]> = [];
      const socket = {
        data: upgradeData,
        readyState: 1,
        send(data: string) {
          sent.push(data);
          return 1;
        },
        close(code?: number, reason?: string) {
          closed.push([code, reason]);
        },
      };
      app.websocket.open(socket as never);
      app.websocket.message(
        socket as never,
        JSON.stringify({ type: "chat_message", text: "too late" })
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(starts).toBe(0);
      expect(closed).toEqual([[1008, "Sessions invalidated"]]);
      expect(app.wsHost.clients.count()).toBe(0);
      expect(app.wsHost.coordinator.authorizationRegistry.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("a parsed frame stays revocable after disconnect until dispatch finishes", async () => {
    let starts = 0;
    const { host } = hostFor(
      makeFakeBackend({
        id: "fake",
        startTurn: async () => {
          starts += 1;
        },
      })
    );
    const handlers = createWsHandlers(host, testPrincipal("revoked"));
    const socket = fakeSocket();
    await handlers.onOpen({} as Event, socket.ws);

    handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "already parsed" }) } as MessageEvent,
      socket.ws
    );
    expect(host.coordinator.authorizationRegistry.size).toBe(1);
    handlers.onClose({ code: 1000, reason: "" } as CloseEvent, socket.ws);
    host.revokePrincipals(["revoked"], 1008, "Sessions invalidated");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(starts).toBe(0);
    expect(host.clients.count()).toBe(0);
    expect(host.coordinator.authorizationRegistry.size).toBe(0);
  });

  test("forced close-all invalidates a parsed frame before releasing its socket", async () => {
    let starts = 0;
    const { host } = hostFor(
      makeFakeBackend({
        id: "fake",
        startTurn: async () => {
          starts += 1;
        },
      })
    );
    const handlers = createWsHandlers(host, testPrincipal("forced-closed"));
    const socket = fakeSocket();
    await handlers.onOpen({} as Event, socket.ws);

    handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "already parsed" }) } as MessageEvent,
      socket.ws
    );
    host.clients.closeAll(1008, "Sessions invalidated");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(starts).toBe(0);
    expect(socket.closed).toEqual([[1008, "Sessions invalidated"]]);
    expect(host.clients.count()).toBe(0);
  });

  test("forced close-for invalidates a parsed frame before releasing its socket", async () => {
    // Same boundary as close-all, one method over: the registry is only useful
    // if every forced-closure path invalidates through it before dropping its
    // references. Measured without the fix: 0 starts became 1.
    let starts = 0;
    const { host } = hostFor(
      makeFakeBackend({
        id: "fake",
        startTurn: async () => {
          starts += 1;
        },
      })
    );
    const target = testPrincipal("forced-for");
    const handlers = createWsHandlers(host, target);
    const socket = fakeSocket();
    await handlers.onOpen({} as Event, socket.ws);

    const bystanderHandlers = createWsHandlers(host, testPrincipal("bystander"));
    const bystanderSocket = fakeSocket();
    await bystanderHandlers.onOpen({} as Event, bystanderSocket.ws);

    handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "already parsed" }) } as MessageEvent,
      socket.ws
    );
    host.clients.closeFor(target.id, 1008, "Sessions invalidated");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(starts).toBe(0);
    expect(socket.closed).toEqual([[1008, "Sessions invalidated"]]);
    // The bystander is untouched: closeFor is per principal, invalidation
    // included.
    expect(bystanderSocket.closed).toEqual([]);
    expect(host.clients.count()).toBe(1);

    bystanderHandlers.onClose({ code: 1000 } as CloseEvent, bystanderSocket.ws);
    handlers.onClose({ code: 1008 } as CloseEvent, socket.ws);
    host.coordinator.reset();
  });

  test("revocation during asynchronous routing prevents startTurn", async () => {
    const routing = deferred();
    let starts = 0;
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async () => {
        starts += 1;
      },
    });
    const { host, registry } = hostFor(backend);
    registry.getPreferredProfileId = async () => {
      await routing.promise;
      return null;
    };
    const authorization = host.coordinator.openAuthorization({
      principalId: "revoked",
      expiresAt: Number.MAX_SAFE_INTEGER,
      valid: true,
    });

    const running = runSession(host, {
      authorization,
      text: "waiting in routing",
      attachments: [],
    });
    authorization.release();
    await until(() => host.coordinator.startingSessions === 1);
    host.revokePrincipals(["revoked"], 1008, "Sessions invalidated");
    routing.resolve();
    await running;

    expect(authorization.valid).toBe(false);
    expect(starts).toBe(0);
    expect(host.coordinator.running.size).toBe(0);
  });

  test("each concurrent startup from one socket stays registered through its own routing", async () => {
    const routing = [deferred(), deferred()];
    let routeCalls = 0;
    let starts = 0;
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async () => {
        starts += 1;
      },
    });
    const { host, registry } = hostFor(backend);
    registry.getPreferredProfileId = async () => {
      const gate = routing[routeCalls++]!;
      await gate.promise;
      return null;
    };
    const handlers = createWsHandlers(host, testPrincipal("revoked"));
    const socket = fakeSocket();
    await handlers.onOpen({} as Event, socket.ws);

    handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "first" }) } as MessageEvent,
      socket.ws
    );
    handlers.onMessage(
      { data: JSON.stringify({ type: "chat_message", text: "second" }) } as MessageEvent,
      socket.ws
    );
    await until(() => host.coordinator.startingSessions === 2);

    routing[0]!.resolve();
    await until(() => starts === 1 && host.coordinator.startingSessions === 1);
    handlers.onClose({ code: 1000, reason: "" } as CloseEvent, socket.ws);
    host.revokePrincipals(["revoked"], 1008, "Sessions invalidated");
    routing[1]!.resolve();
    await until(() => host.coordinator.startingSessions === 0);

    expect(starts).toBe(1);
    expect(host.coordinator.authorizationRegistry.size).toBe(0);
  });

  test("revocation while billing is pending prevents startTurn", async () => {
    const billing = deferred();
    let billingCalls = 0;
    let starts = 0;
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async () => {
        starts += 1;
      },
    });
    const { host, registry } = activityHostFor(backend);
    registry.listAllProviders = async () => {
      billingCalls += 1;
      await billing.promise;
      return [];
    };
    const authorization = host.coordinator.openAuthorization({
      principalId: "revoked",
      expiresAt: Number.MAX_SAFE_INTEGER,
      valid: true,
    });

    const running = runSession(host, {
      authorization,
      text: "waiting in billing",
      sessionId: "session-billing",
      attachments: [],
    });
    authorization.release();
    await until(() => billingCalls === 1);
    host.revokePrincipals(["revoked"], 1008, "Sessions invalidated");
    billing.resolve();
    await running;

    expect(authorization.valid).toBe(false);
    expect(starts).toBe(0);
  });

  test("a cancellation accepted during startup survives the sender's revocation", async () => {
    // Both halves are buffered work with no recorder yet: the cancel arrives
    // while billing is in flight, and the revocation then takes the ordinary
    // drain path away. The decision was still someone's, so it must be recorded.
    const billing = deferred();
    let billingCalls = 0;
    const backend = makeFakeBackend({ id: "fake", startTurn: async () => {} });
    const { host, registry } = activityHostFor(backend);
    const db = databases[databases.length - 1]!;
    registry.listAllProviders = async () => {
      billingCalls += 1;
      await billing.promise;
      return [];
    };
    const authorization = host.coordinator.openAuthorization({
      principalId: "owner-a",
      expiresAt: Number.MAX_SAFE_INTEGER,
      valid: true,
    });

    const running = runSession(host, {
      authorization,
      text: "cancelled mid-startup",
      sessionId: "session-cancel",
      attachments: [],
    });
    authorization.release();
    await until(() => billingCalls === 1);

    const turn = [...host.coordinator.running][0]!;
    turn.pendingCancellationPrincipalIds.push("owner-b");
    host.revokePrincipals(["owner-a"], 1008, "Sessions invalidated");
    billing.resolve();
    await running;

    const events = db
      .query(
        "SELECT event_type AS type, payload FROM activity_events WHERE event_type = 'turn_cancelled'"
      )
      .all() as Array<{ type: string; payload: string }>;
    expect(events.map((e) => JSON.parse(e.payload).v.principalId)).toEqual(["owner-b"]);
    host.coordinator.reset();
  });

  test("revocation keeps a running turn, drops its sender's queued work, and runs another sender's", async () => {
    const releaseFirst = deferred();
    const prompts: string[] = [];
    const signals: AbortSignal[] = [];
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        prompts.push(request.prompt);
        signals.push(request.signal);
        if (request.prompt === "running") await releaseFirst.promise;
      },
    });
    const { host } = hostFor(backend);
    const revoked = host.coordinator.openAuthorization({
      principalId: "revoked",
      expiresAt: Number.MAX_SAFE_INTEGER,
      valid: true,
    });
    const survivor = host.coordinator.openAuthorization({
      principalId: "survivor",
      expiresAt: Number.MAX_SAFE_INTEGER,
      valid: true,
    });
    const revokedSocket = fakeSocket();
    const survivorSocket = fakeSocket();
    host.clients.add(revokedSocket.ws, revoked.principalId, { onRemove: revoked.release });
    host.clients.add(survivorSocket.ws, survivor.principalId, { onRemove: survivor.release });

    const running = runSession(host, {
      authorization: revoked,
      text: "running",
      sessionId: "session-1",
      attachments: [],
    });
    await until(() => prompts.length === 1);
    await handleChatMessage(host, fakeSocket().ws, {
      authorization: revoked,
      text: "discard me",
      sessionId: "session-1",
      attachments: [],
    });
    await handleChatMessage(host, fakeSocket().ws, {
      authorization: survivor,
      text: "run me",
      sessionId: "session-1",
      attachments: [],
    });
    expect(host.coordinator.bySession.get("session-1")?.queue).toHaveLength(2);

    host.revokePrincipals(["revoked"], 1008, "Sessions invalidated");
    expect(signals[0]!.aborted).toBe(false);
    expect(host.coordinator.bySession.get("session-1")?.queue.map((entry) => entry.text)).toEqual([
      "run me",
    ]);
    const revokedFrameCount = revokedSocket.sent.length;
    const survivorFrameCount = survivorSocket.sent.length;
    host.sendToClients({ type: "status", status: "thinking" });
    expect(revokedSocket.sent).toHaveLength(revokedFrameCount);
    expect(survivorSocket.sent).toHaveLength(survivorFrameCount + 1);
    releaseFirst.resolve();
    await running;

    expect(prompts).toEqual(["running", "run me"]);
    expect(signals[0]!.aborted).toBe(false);
    host.clients.closeAll(1000, "test complete");
  });

  test.each([
    ["resolves", false],
    ["rejects", true],
  ] as const)(
    "a native backend follow-up that %s stays revocable after its sender disconnects",
    async (_outcome, rejects) => {
      const releaseOriginal = deferred();
      let settleFollowUp!: () => void;
      let rejectFollowUp!: (error: Error) => void;
      const pendingFollowUp = new Promise<void>((resolve, reject) => {
        settleFollowUp = resolve;
        rejectFollowUp = reject;
      });
      let followUpCalls = 0;
      const backend = makeFakeBackend({
        id: "fake",
        capabilities: { followUp: true },
        startTurn: async () => {
          await releaseOriginal.promise;
        },
        followUp: async () => {
          followUpCalls += 1;
          await pendingFollowUp;
        },
      });
      const { host } = hostFor(backend);
      const originalHandlers = createWsHandlers(host, testPrincipal("original-sender"));
      const followUpHandlers = createWsHandlers(host, testPrincipal("follow-up-sender"));
      const originalSocket = fakeSocket();
      const followUpSocket = fakeSocket();
      await originalHandlers.onOpen({} as Event, originalSocket.ws);
      await followUpHandlers.onOpen({} as Event, followUpSocket.ws);

      originalHandlers.onMessage(
        {
          data: JSON.stringify({
            type: "chat_message",
            text: "original",
            sessionId: "session-native-follow-up",
          }),
        } as MessageEvent,
        originalSocket.ws
      );
      await until(() => host.coordinator.bySession.has("session-native-follow-up"));
      followUpHandlers.onMessage(
        {
          data: JSON.stringify({
            type: "chat_message",
            text: "native follow-up",
            sessionId: "session-native-follow-up",
          }),
        } as MessageEvent,
        followUpSocket.ws
      );
      await until(() => followUpCalls === 1);

      const followUpAuthorization = [...host.coordinator.authorizationRegistry.keys()].find(
        (authorization) => authorization.principalId === "follow-up-sender"
      )!;
      followUpHandlers.onClose({ code: 1000, reason: "" } as CloseEvent, followUpSocket.ws);
      releaseOriginal.resolve();
      await until(() => host.coordinator.running.size === 0);

      host.revokePrincipals(["follow-up-sender"], 1008, "Sessions invalidated");
      expect(followUpAuthorization.valid).toBe(false);

      if (rejects) rejectFollowUp(new Error("native follow-up failed"));
      else settleFollowUp();
      await until(() => !host.coordinator.authorizationRegistry.has(followUpAuthorization));

      originalHandlers.onClose({ code: 1000, reason: "" } as CloseEvent, originalSocket.ws);
      expect(host.coordinator.authorizationRegistry.size).toBe(0);
    }
  );

  test("expiry closes an open socket and drops its queued follow-up", async () => {
    const releaseRunning = deferred();
    const prompts: string[] = [];
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        prompts.push(request.prompt);
        if (request.prompt === "running") await releaseRunning.promise;
      },
    });
    const { host } = hostFor(backend);
    const principal = {
      ...testPrincipal("expiring"),
      expiresAt: Date.now() + 50,
    };
    const handlers = createWsHandlers(host, principal);
    const socket = fakeSocket();
    await handlers.onOpen({} as Event, socket.ws);

    handlers.onMessage(
      {
        data: JSON.stringify({
          type: "chat_message",
          text: "running",
          sessionId: "session-expiry",
        }),
      } as MessageEvent,
      socket.ws
    );
    await until(() => prompts.length === 1);
    handlers.onMessage(
      {
        data: JSON.stringify({
          type: "chat_message",
          text: "queued after running",
          sessionId: "session-expiry",
        }),
      } as MessageEvent,
      socket.ws
    );
    await until(
      () => host.coordinator.bySession.get("session-expiry")?.queue.length === 1
    );

    // Release the running turn AFTER expiry but BEFORE the sweep: the dequeue
    // then happens inside the window the timer has not reached yet, which is
    // precisely where a follow-up could start past expiry and survive, since a
    // started turn is never aborted.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(principal.expiresAt).toBeLessThan(Date.now());
    expect(socket.closed).toEqual([]);
    releaseRunning.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toEqual(["running"]);

    await until(() => socket.closed.length === 1, 1_500);
    expect(socket.closed).toEqual([[1008, "Session expired"]]);
    expect(prompts).toEqual(["running"]);
    // The follow-up never ran, and the slot itself is gone once the running
    // turn finished — a stronger outcome than an emptied queue.
    expect(host.coordinator.bySession.get("session-expiry")?.queue ?? []).toEqual([]);

    handlers.onMessage(
      {
        data: JSON.stringify({
          type: "chat_message",
          text: "after expiry",
          sessionId: "session-expiry",
        }),
      } as MessageEvent,
      socket.ws
    );
    releaseRunning.resolve();
    await until(() => host.coordinator.running.size === 0);

    expect(prompts).toEqual(["running"]);
  });

  test("a disconnected queued sender becomes the current authority when dequeued", async () => {
    const releaseFirst = deferred();
    const releaseSecondBilling = deferred();
    const prompts: string[] = [];
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        prompts.push(request.prompt);
        if (request.prompt === "first") await releaseFirst.promise;
      },
    });
    const { host, registry } = activityHostFor(backend);
    const listProviders = registry.listAllProviders.bind(registry);
    let billingCalls = 0;
    registry.listAllProviders = async (options) => {
      billingCalls += 1;
      if (billingCalls === 2) await releaseSecondBilling.promise;
      return listProviders(options);
    };
    const firstHandlers = createWsHandlers(host, testPrincipal("first-principal"));
    const queuedHandlers = createWsHandlers(host, testPrincipal("queued-principal"));
    const firstSocket = fakeSocket();
    const queuedSocket = fakeSocket();
    await firstHandlers.onOpen({} as Event, firstSocket.ws);
    await queuedHandlers.onOpen({} as Event, queuedSocket.ws);

    firstHandlers.onMessage(
      {
        data: JSON.stringify({
          type: "chat_message",
          text: "first",
          sessionId: "session-queue",
        }),
      } as MessageEvent,
      firstSocket.ws
    );
    await until(() => prompts.length === 1);
    queuedHandlers.onMessage(
      {
        data: JSON.stringify({
          type: "chat_message",
          text: "queued",
          sessionId: "session-queue",
        }),
      } as MessageEvent,
      queuedSocket.ws
    );
    await until(() => host.coordinator.bySession.get("session-queue")?.queue.length === 1);
    queuedHandlers.onClose({ code: 1000, reason: "" } as CloseEvent, queuedSocket.ws);

    releaseFirst.resolve();
    await until(() => billingCalls === 2);
    const dequeued = host.coordinator.bySession.get("session-queue")!;
    expect(dequeued.principalId).toBe("queued-principal");
    expect(dequeued.authorization.principalId).toBe("queued-principal");

    host.revokePrincipals(["queued-principal"], 1008, "Sessions invalidated");
    releaseSecondBilling.resolve();
    await until(() => host.coordinator.running.size === 0);

    expect(prompts).toEqual(["first"]);
    firstHandlers.onClose({ code: 1000, reason: "" } as CloseEvent, firstSocket.ws);
  });

  test("revocation is recorded on a running turn without changing its outcome", async () => {
    const release = deferred();
    const signals: AbortSignal[] = [];
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        signals.push(request.signal);
        await release.promise;
      },
    });
    const { host, store } = activityHostFor(backend);
    const authorization = host.coordinator.openAuthorization({
      principalId: "revoked",
      expiresAt: Number.MAX_SAFE_INTEGER,
      valid: true,
    });
    const running = runSession(host, {
      authorization,
      text: "keep running",
      sessionId: "session-recording",
      attachments: [],
    });
    authorization.release();
    await until(() => signals.length === 1);
    const turnId = host.coordinator.bySession.get("session-recording")!.turnId;

    host.revokePrincipals(["revoked"], 1008, "Sessions invalidated");
    expect(signals[0]!.aborted).toBe(false);
    release.resolve();
    await running;

    const snapshot = store.snapshotRun(turnId)!;
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({
        eventType: "principal_revoked",
        payload: { principalId: "revoked" },
      })
    );
    expect(snapshot.spans.find((span) => span.kind === "turn")?.outcome).toBe("success");
  });

  test("a revoked principal cannot answer its pending approval", async () => {
    const backend = makeFakeBackend({ id: "fake" });
    const { host } = hostFor(backend);
    const principal = testPrincipal("revoked");
    const authorization = host.coordinator.openAuthorization({
      principalId: principal.id,
      expiresAt: Number.MAX_SAFE_INTEGER,
      valid: true,
    });
    const timeoutHandle = setTimeout(() => {}, 0);
    clearTimeout(timeoutHandle);
    const turn: RunningTurn = {
      principalId: principal.id,
      authorization,
      sessionId: "session-1",
      turnId: "turn-1",
      draftId: null,
      providerId: "fake",
      backend,
      abortController: new AbortController(),
      timeoutHandle,
      queue: [],
      pendingCancellationPrincipalIds: [],
      cancelled: false,
      lastResult: null,
    };
    let decision: PermissionDecision | null = null;
    host.coordinator.running.add(turn);
    host.coordinator.pendingApprovals.set("tool-1", {
      turn,
      turnId: turn.turnId,
      request: { toolUseId: "tool-1", toolName: "Write", input: {} },
      resolve: (value) => {
        decision = value;
      },
    });
    const handlers = createWsHandlers(host, principal);
    const socket = fakeSocket();
    await handlers.onOpen({} as Event, socket.ws);

    host.revokePrincipals([principal.id], 1008, "Sessions invalidated");
    handlers.onMessage(
      {
        data: JSON.stringify({
          type: "tool_approval",
          toolUseId: "tool-1",
          turnId: "turn-1",
        }),
      } as MessageEvent,
      socket.ws
    );
    await Promise.resolve();

    expect(decision).toBeNull();
    expect(host.coordinator.pendingApprovals.has("tool-1")).toBe(true);
    host.coordinator.reset();
    authorization.release();
  });
});

describe("disconnect is not revocation, but it does end registration", () => {
  // Both cases are the same shape as the races reviewed above, one layer out:
  // work parsed or started BEFORE the socket closed must not register new
  // per-connection state AFTER the close cleanup ran.

  test("an activity_subscribe parsed before close does not resurrect the socket", async () => {
    const { host } = activityHostFor();
    const handlers = createWsHandlers(host, testPrincipal("subscriber"));
    const socket = fakeSocket();
    await handlers.onOpen({} as Event, socket.ws);

    // Parsed while open; dispatch runs on a microtask, which the close beats.
    handlers.onMessage(
      { data: JSON.stringify({ type: "activity_subscribe", view: "index" }) } as MessageEvent,
      socket.ws
    );
    handlers.onClose({ code: 1000 } as CloseEvent, socket.ws);
    const atClose = host.activity!.stream.subscriptionCount();

    await Promise.resolve();
    await Promise.resolve();

    expect(atClose).toBe(0);
    // Without the guard this is 1: the registry holds a closed socket forever,
    // and isWatched keeps the activity poller running for the process's life.
    expect(host.activity!.stream.subscriptionCount()).toBe(0);
    host.coordinator.reset();
  });

  test("snapshot-on-connect stays revocable while its history is still loading", async () => {
    let releaseHistory: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const backend = makeFakeBackend({
      id: "fake",
      getHistory: async () => {
        await pending;
        return [{ role: "user" as const, content: "old turn", toolCalls: [] }];
      },
    });
    const { host } = hostFor(backend);
    const principal = testPrincipal("opener");
    const handlers = createWsHandlers(host, principal);
    const socket = fakeSocket();

    // One running turn puts onOpen on the snapshot-on-connect path.
    host.coordinator.running.add({
      sessionId: "session-1",
      turnId: "turn-1",
      backend,
      providerId: null,
      draftId: null,
      cancelled: false,
      queue: [],
      lastResult: null,
    } as never);

    const opening = handlers.onOpen({} as Event, socket.ws);
    await Promise.resolve();

    // The admission registration is already released; this async work must
    // still be discoverable, or a revocation now finds nothing to invalidate.
    expect([...host.coordinator.authorizationRegistry.values()]).toEqual([2]);

    host.revokePrincipals([principal.id], 1008, "Sessions invalidated");
    releaseHistory!();
    await opening;

    const framesAfterRevocation = socket.sent
      .map((raw) => JSON.parse(raw).type as string)
      .filter((type) => type === "session_history");
    expect(framesAfterRevocation).toEqual([]);
    host.coordinator.running.clear();
    host.coordinator.reset();
  });
});

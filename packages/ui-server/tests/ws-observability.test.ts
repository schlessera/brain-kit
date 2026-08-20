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

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";

/** A socket that records what the server sent it. */
function fakeSocket(): WSContext & { sent: string[] } {
  const sent: string[] = [];
  return {
    send: (data: string) => sent.push(data),
    close: () => {},
    readyState: 1,
    sent,
  } as unknown as WSContext & { sent: string[] };
}

function setup() {
  const db = createUiDb(":memory:");
  const observability = createRecordingObservability();
  const backend = makeFakeBackend({ id: "fake" });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    observability,
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

    const serialized = JSON.stringify(observability.logs.records());
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
  test("carries the recorded series, JSON-safe", () => {
    const { db, observability, handlers } = setup();
    close = () => db.close();

    handlers.onMessage({ data: "{bad" } as MessageEvent, fakeSocket());

    const snapshot = observability.metrics.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot).toEqual([
      {
        name: "ws.frames.dropped",
        attributes: { direction: "inbound", reason: "parse_error" },
        value: 1,
        kind: "counter",
      },
    ]);
  });
});

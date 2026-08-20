/**
 * Inbound frame metering — the last unmetered axis on the socket.
 *
 * The bar this has to clear is not "does it block a flood"; it is "does it
 * never block a real client". A limiter that fires on legitimate traffic gets
 * turned off, and then it protects nothing.
 */
import { describe, expect, test } from "bun:test";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { FrameRateLimiter, type Clock } from "../src/ws/rate-limit";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";

/** A clock the test advances by hand. */
function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe("the bucket", () => {
  test("absorbs a burst, then meters at the sustained rate", () => {
    const clock = fakeClock();
    const limiter = new FrameRateLimiter({ ratePerSecond: 10, burst: 5, clock });

    // The burst goes through with no time passing at all.
    for (let i = 0; i < 5; i++) expect(limiter.take().allowed).toBe(true);
    expect(limiter.take().allowed).toBe(false);

    // 10/s means one token per 100ms.
    clock.advance(100);
    expect(limiter.take().allowed).toBe(true);
    expect(limiter.take().allowed).toBe(false);
  });

  test("refills to the burst ceiling and no further", () => {
    // Otherwise an idle connection banks unlimited credit and the sustained
    // rate stops meaning anything.
    const clock = fakeClock();
    const limiter = new FrameRateLimiter({ ratePerSecond: 10, burst: 3, clock });

    clock.advance(60_000);
    for (let i = 0; i < 3; i++) expect(limiter.take().allowed).toBe(true);
    expect(limiter.take().allowed).toBe(false);
  });

  test("counts what it refused", () => {
    const clock = fakeClock();
    const limiter = new FrameRateLimiter({ ratePerSecond: 1, burst: 1, clock });
    limiter.take();
    limiter.take();
    limiter.take();
    expect(limiter.rejectedCount).toBe(2);
  });

  test("a burst below 1 is clamped rather than blocking everything", () => {
    const limiter = new FrameRateLimiter({ ratePerSecond: 1, burst: 0, clock: fakeClock() });
    expect(limiter.take().allowed).toBe(true);
  });
});

function fakeSocket(): WSContext & { sent: string[] } {
  const sent: string[] = [];
  return { send: (d: string) => sent.push(d), sent } as unknown as WSContext & { sent: string[] };
}

function setup(wsRate?: { ratePerSecond: number; burst: number }) {
  const db = createUiDb(":memory:");
  const observability = createRecordingObservability();
  const backend = makeFakeBackend({ id: "fake" });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    observability,
    ...(wsRate ? { wsRate } : {}),
  });
  return { db, host, observability, handlers: createWsHandlers(host) };
}

describe("on the socket", () => {
  test("a flood is refused, counted, and told why", () => {
    const { db, observability, handlers } = setup({ ratePerSecond: 1, burst: 2 });
    const ws = fakeSocket();

    for (let i = 0; i < 6; i++) {
      handlers.onMessage({ data: JSON.stringify({ type: "cancel", sessionId: "s1" }) } as MessageEvent, ws);
    }

    const refusals = ws.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.code === "RATE_LIMITED");
    expect(refusals.length).toBe(4);
    expect(observability.metrics.value("ws.frames.dropped", {
      reason: "rate_limited",
      direction: "inbound",
    })).toBe(4);
    db.close();
  });

  test("metering happens BEFORE parsing", () => {
    // The work being bounded is mostly parsing, so a refused frame must not be
    // parsed first. A refused MALFORMED frame proves the ordering: it comes
    // back as RATE_LIMITED, not PARSE_ERROR.
    const { db, handlers } = setup({ ratePerSecond: 1, burst: 1 });
    const ws = fakeSocket();

    handlers.onMessage({ data: JSON.stringify({ type: "cancel", sessionId: "s" }) } as MessageEvent, ws);
    handlers.onMessage({ data: "{not json" } as MessageEvent, ws);

    expect(JSON.parse(ws.sent[ws.sent.length - 1]).code).toBe("RATE_LIMITED");
    db.close();
  });

  test("each connection gets its own budget", () => {
    // One noisy tab must not throttle another, and one peer must not throttle
    // everyone else.
    const { db, host } = setup({ ratePerSecond: 1, burst: 1 });
    const a = createWsHandlers(host);
    const b = createWsHandlers(host);
    const wsA = fakeSocket();
    const wsB = fakeSocket();
    const frame = { data: JSON.stringify({ type: "cancel", sessionId: "s" }) } as MessageEvent;

    a.onMessage(frame, wsA);
    a.onMessage(frame, wsA); // A is now out of budget
    b.onMessage(frame, wsB);

    expect(wsA.sent.some((s) => JSON.parse(s).code === "RATE_LIMITED")).toBe(true);
    expect(wsB.sent.some((s) => JSON.parse(s).code === "RATE_LIMITED")).toBe(false);
    db.close();
  });

  test("no policy means no metering", () => {
    const { db, handlers } = setup();
    const ws = fakeSocket();
    for (let i = 0; i < 200; i++) {
      handlers.onMessage({ data: JSON.stringify({ type: "cancel", sessionId: "s" }) } as MessageEvent, ws);
    }
    expect(ws.sent.some((s) => JSON.parse(s).code === "RATE_LIMITED")).toBe(false);
    db.close();
  });

  test("the shipped defaults pass realistic traffic untouched", () => {
    // Opening the app: a resume, an environment report, a first message, then
    // a dozen approvals during a busy turn. If this ever trips, the defaults
    // are wrong — not the test.
    const { db, handlers } = setup({ ratePerSecond: 20, burst: 60 });
    const ws = fakeSocket();
    for (let i = 0; i < 40; i++) {
      handlers.onMessage(
        { data: JSON.stringify({ type: "cancel", sessionId: `s${i}` }) } as MessageEvent,
        ws
      );
    }
    expect(ws.sent.some((s) => JSON.parse(s).code === "RATE_LIMITED")).toBe(false);
    db.close();
  });
});

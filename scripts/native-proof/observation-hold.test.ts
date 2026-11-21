import { expect, test } from "bun:test";
import { watchdogMs } from "../test-deadlines.js";
import { observationHold, observationMatrixResponse } from "./observation-hold.js";

for (const failed of [false, true]) test(`nested observation holds resume only after their whole physical window; failed=${failed}`, async () => {
  let now = 0;
  const events: string[] = [];
  const hold = observationHold({ freeze() { events.push("freeze"); }, resume() { events.push("resume"); }, kill() { events.push("kill"); } }, () => now);
  hold.before(); now = 4; hold.before(); now = 7; hold.after(!failed);
  expect(events, "NESTED_HOLD_DOES_NOT_RESUME_PEER").toEqual(["freeze"]);
  let idle = false; const settled = hold.idle().then(() => { idle = true; });
  await Promise.resolve(); expect(idle).toBe(false);
  now = 11; hold.after(true); await settled;
  expect(events, "FAILED_NESTED_HOLD_STAYS_FAILED").toEqual(["freeze", failed ? "kill" : "resume"]);
  expect(hold.sample(), "PHYSICAL_FREEZE_COUNTS_ENTIRE_WINDOW").toEqual({ frozenMs: 11, sharedHold: true, startedAt: 0, endedAt: 11 });
  now = 20; hold.before(); now = 25; hold.after(true);
  expect(hold.sample()).toEqual({ frozenMs: 5, sharedHold: false, startedAt: 20, endedAt: 25 });
});

test("matrix HTTP response survives the real Bun server idle timeout", async () => {
  // Longer than the server's real idle timer (whose tick can round upward).
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 1,
    fetch(request, server) { server.timeout(request, 1); return observationMatrixResponse(request, server, async () => { await Bun.sleep(6000); return { recorded: 10000 }; }); } });
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(new Error("matrix test watchdog")), watchdogMs(20000));
  try {
    const result = await fetch(`http://127.0.0.1:${server.port}/matrix`, { signal: abort.signal }).then(async response => ({ error: null, status: response.status, body: await response.json() }), error => ({ error: String(error), status: null, body: null }));
    expect(result.error, "MATRIX_TRANSPORT_SURVIVES_SERVER_IDLE_TIMEOUT").toBeNull();
    expect(result.status).toBe(200); expect(result.body).toEqual({ recorded: 10000 });
  } finally { clearTimeout(timer); server.stop(true); }
});

test("matrix client disables an armed socket idle timer while retaining its abort watchdog", async () => {
  const http = await import("node:http"), { spyOn } = await import("bun:test"), { observationMatrixRequest } = await import("./observation-hold.js");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { await Bun.sleep(120); return Response.json({ recorded: 10000 }); } });
  const get = http.get;
  const armed = spyOn(http, "get").mockImplementation(((...args: unknown[]) => {
    const request = Reflect.apply(get, http, args); request.setTimeout(10, () => request.destroy(new Error("client idle timeout"))); return request;
  }) as typeof http.get);
  try {
    const outcome = await observationMatrixRequest(`http://127.0.0.1:${server.port}/matrix`, AbortSignal.timeout(watchdogMs(10000))).then(async response => ({ error: null, body: await response.json() }), error => ({ error: String(error), body: null }));
    expect(outcome.error, "MATRIX_CLIENT_IDLE_TIMEOUT_CANNOT_CUT_OFF_RESPONSE").toBeNull();
    expect(outcome.body).toEqual({ recorded: 10000 });
  } finally { armed.mockRestore(); server.stop(true); }
});

test("matrix client abort watchdog cancels a stalled response", async () => {
  const { observationMatrixRequest } = await import("./observation-hold.js");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { entered.resolve(); await release.promise; return Response.json({ recorded: 10000 }); } });
  const abort = new AbortController();
  const request = observationMatrixRequest(`http://127.0.0.1:${server.port}/matrix`, abort.signal).then(() => false, () => true);
  try {
    await entered.promise; abort.abort(new Error("matrix watchdog"));
    expect(await request, "MATRIX_EXPLICIT_WATCHDOG_STILL_CANCELS_REQUEST").toBe(true);
  } finally { release.resolve(); server.stop(true); }
});

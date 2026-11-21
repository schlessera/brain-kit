import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startInferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { MAX_INFERENCE_REQUEST_BYTES } from "../../ui-sdk/src/server/inference-relay";
import { journalInference } from "../src/brain/journal-inference";
import { body, fixture, send } from "./helpers/deferred-freeze-fixture";

const cycle = () => new Promise<void>(resolve => setImmediate(resolve));
const operation = (f: Awaited<ReturnType<typeof fixture>>) => f.proxy.inference("POST", new URL("http://127.0.0.1/v1/messages"), new AbortController().signal);
function hold(f: Awaited<ReturnType<typeof fixture>>) {
  const checkpoint = f.native.manager.checkpoint, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
  return { entered: entered.promise, release: release.resolve, restore() { release.resolve(); f.native.manager.checkpoint = checkpoint; } };
}

for (const cause of ["predicate throw", "immediate void stop"] as const) test(`${cause} gates dispatch and response until its own commit (T1/T2)`, async () => {
  const f = await fixture(); let op: ReturnType<typeof operation> | undefined;
  let blocked: ReturnType<typeof hold> | undefined, upstream = 0, delivered = false;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; return new Response("Ithaca"); } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: f.proxy });
  try {
    if (cause === "immediate void stop") {
      f.ack(undefined); const prior = f.result(); op = operation(f);
      await op.prepareDispatch(Buffer.from(body())); expect(op.dispatch()).toBe(false);
      await prior; op.finish("cancelled"); op = undefined;
    }
    blocked = hold(f);
    const saved = (f.db.query("SELECT summary FROM turn_scope WHERE turn_id='voyage'").get() as { summary: string }).summary;
    if (cause === "predicate throw") f.db.query("UPDATE turn_scope SET summary='{' WHERE turn_id='voyage'").run();
    const observed = f.result("sail"); void observed.catch(() => {});
    f.db.query("UPDATE turn_scope SET summary=? WHERE turn_id='voyage'").run(saved);
    op = operation(f);
    let ready = false;
    const response = op.responseReady().then(value => { ready = true; return value; });
    const relayed = send(relay.socketPath, body("sail"), "/v1/messages", {}, "POST", () => { delivered = true; }); void relayed.catch(() => {});
    await blocked.entered; await cycle();
    expect(op.dispatch(), "REQUIRED_RESULT_BLOCKS_UPSTREAM_UNTIL_COMMIT").toBe(false);
    expect(ready, "REQUIRED_RESULT_BLOCKS_RESPONSE_UNTIL_COMMIT").toBe(false);
    expect(upstream, "IMMEDIATE_RESULT_SENDS_NO_UPSTREAM_BEFORE_COMMIT").toBe(0);
    expect(delivered, "IMMEDIATE_RESULT_SENDS_NO_RESPONSE_BEFORE_COMMIT").toBe(false);
    blocked.release(); await observed; expect(await response).toBe(true);
    expect(op.dispatch()).toBe(true); expect((await relayed).status).toBe(200);
  } finally { blocked?.restore(); op?.finish("cancelled"); relay.stop(); origin.stop(true); await f.close(); }
});

test("a fallback cap refuses a straggler until Continue (T3)", async () => {
  const f = await fixture(1); let op: ReturnType<typeof operation> | undefined, upstream = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; return new Response("Ithaca"); } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: f.proxy });
  try {
    writeFileSync(join(f.brain, "note.md"), "Penelope");
    const observed = f.result(); f.fireDeadline(); await observed;
    op = operation(f); await op.prepareDispatch(Buffer.from(body()));
    expect(op.dispatch(), "PAUSED_STRAGGLER_CANNOT_DISPATCH").toBe(false);
    expect((await send(relay.socketPath)).status, "PAUSED_STRAGGLER_RECEIVES_403").toBe(403);
    expect(upstream).toBe(0);
    const receipt = f.journal.summary("voyage").scope!.receipts.at(-1)!;
    expect((await f.scope.decide({ type: "scope_decision", turnId: "voyage", sessionId: "ithaca", eventId: receipt.eventId, submissionId: "captain", action: "continue" }, true)).state).toBe("accepted");
    expect(op.dispatch(), "STRAGGLER_MAY_DISPATCH_AFTER_CONTINUE").toBe(true);
    expect((await send(relay.socketPath)).status).toBe(200); expect(upstream).toBe(1);
  } finally { op?.finish("cancelled"); relay.stop(); origin.stop(true); await f.close(); }
});

const exits = ["405", "403", "admit false", "first admit throws", "second admit throws", "credential throw", "body size", "byte cap", "abort", "upstream failure", "redirect", "success"] as const;
for (const cause of exits) test(`every relay exit gates ${cause} and observes exactly once (T4)`, async () => {
  const f = await fixture(), blocked = hold(f);
  let observations = 0, delivered = false, admissions = 0;
  f.journal.onObservation(() => { observations++; });
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca", { status: cause === "redirect" ? 302 : 200 }) });
  const originalFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign((...args: Parameters<typeof fetch>) => {
    if (cause === "upstream failure" && String(args[0]).startsWith(origin.url.origin)) return Promise.reject(new Error("fixture upstream unavailable"));
    return originalFetch(...args);
  }, { preconnect: originalFetch.preconnect }));
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: async () => {
    if (cause === "credential throw") throw Error("fixture credentials unavailable"); return {};
  }, egress: { ...f.proxy, inference(...args) {
    const op = f.proxy.inference(...args);
    return { ...op, signal: cause === "abort" ? AbortSignal.abort() : op.signal,
      charge: cause === "byte cap" ? () => false : op.charge,
      async admit() {
        admissions++;
        if (cause === "admit false") return false;
        if (cause === "first admit throws" && admissions === 1 || cause === "second admit throws" && admissions === 2) throw Error("fixture safety read failed");
        return op.admit();
      } };
  } } });
  try {
    const observed = f.result(); void observed.catch(() => {});
    const response = send(relay.socketPath, body(), cause === "403" ? "/forbidden" : "/v1/messages",
      cause === "body size" ? { "content-length": String(MAX_INFERENCE_REQUEST_BYTES + 1) } : {}, cause === "405" ? "PUT" : "POST", () => { delivered = true; });
    void response.catch(() => {});
    const first = await Promise.race([blocked.entered.then(() => "observation"), response.then(() => "response")]);
    expect(first, "EVERY_EXIT_STARTS_THE_REQUIRED_OBSERVATION").toBe("observation");
    await cycle(); await cycle();
    expect(delivered, "EVERY_EXIT_WITHHOLDS_ALL_RESPONSE_BYTES_UNTIL_COMMIT").toBe(false);
    blocked.release(); await observed;
    const expected = cause === "405" ? 405 : ["403", "admit false", "byte cap"].includes(cause) ? 403 : cause.includes("admit throws") ? 500 : cause === "credential throw" ? 503 : cause === "body size" ? 413 : cause === "abort" ? 499 : ["redirect", "upstream failure"].includes(cause) ? 502 : 200;
    expect((await response).status).toBe(expected);
    expect(observations, "EACH_EXIT_OBSERVES_ITS_RESULT_EXACTLY_ONCE").toBe(1);
  } finally { blocked.restore(); relay.stop(); origin.stop(true); fetchSpy.mockRestore(); await f.close(); }
});

test("authority lost after canDefer cannot manufacture a stop receipt (T5)", async () => {
  const f = await fixture(); let op: ReturnType<typeof operation> | undefined;
  const original = f.scope.canDefer; let flip = false;
  const read = spyOn(f.scope, "canDefer").mockImplementation(id => { const allowed = original(id); if (flip) f.authority(false); return allowed; });
  try {
    const observed = f.result(); op = operation(f); await op.prepareDispatch(Buffer.from(body())); flip = true;
    expect(op.dispatch(), "ZERO_ACKNOWLEDGED_WORKERS_CANNOT_SPECULATE").toBe(false);
    expect(f.stops).toBe(0); await observed;
  } finally { read.mockRestore(); op?.finish("cancelled"); await f.close(); }
});

test("a second result cannot speculate for an older generation (T6)", async () => {
  const f = await fixture(), blocked = hold(f); let op: ReturnType<typeof operation> | undefined;
  try {
    const first = f.result(); op = operation(f); await op.prepareDispatch(Buffer.from(body()));
    const second = f.result("sail"); await blocked.entered;
    expect(op.dispatch(), "OLDER_GENERATION_CANNOT_AUTHORIZE_SPECULATION").toBe(false);
    blocked.release(); await first; await second;
  } finally { blocked.restore(); op?.finish("cancelled"); await f.close(); }
});

test("N results retain N observations and a periodic commit cannot open their gate (T7)", async () => {
  const f = await fixture(); let op: ReturnType<typeof operation> | undefined;
  const checkpoint = f.native.manager.checkpoint, periodicEntered = Promise.withResolvers<void>(), resultEntered = Promise.withResolvers<void>();
  const periodicRelease = Promise.withResolvers<void>(), firstResultRelease = Promise.withResolvers<void>(), resultsRelease = Promise.withResolvers<void>();
  const nextResultEntered = Promise.withResolvers<void>();
  let checkpoints = 0, observations = 0;
  f.native.manager.checkpoint = async (...args) => {
    if (++checkpoints === 1) { periodicEntered.resolve(); await periodicRelease.promise; }
    else if (checkpoints === 2) { resultEntered.resolve(); await firstResultRelease.promise; }
    else { nextResultEntered.resolve(); await resultsRelease.promise; }
    return checkpoint(...args);
  };
  f.journal.onObservation(() => { observations++; });
  try {
    f.tick(); await periodicEntered.promise;
    const results = [f.result("loom"), f.result("sail"), f.result("bow")];
    op = operation(f); periodicRelease.resolve(); await resultEntered.promise;
    expect(op.dispatch(), "PERIODIC_COMMIT_CANNOT_SATISFY_RESULT_GENERATIONS").toBe(false);
    let ready = false; const response = op.responseReady().then(value => { ready = true; return value; }); await cycle();
    expect(ready).toBe(false); firstResultRelease.resolve(); await results[0]; await nextResultEntered.promise; await cycle();
    expect(ready, "RESPONSE_GATE_RECHECKS_AFTER_EACH_RESULT_COMMIT").toBe(false);
    resultsRelease.resolve(); await Promise.all(results); expect(await response).toBe(true);
    expect(observations, "N_RESULTS_GET_N_DISTINCT_OBSERVATIONS").toBe(4);
  } finally { periodicRelease.resolve(); firstResultRelease.resolve(); resultsRelease.resolve(); f.native.manager.checkpoint = checkpoint; op?.finish("cancelled"); await f.close(); }
});

test("a rejected observation refuses only its turn (T8)", async () => {
  const f = await fixture();
  const control = journalInference(f.journal)!;
  let fail = true;
  const unsubscribe = f.journal.onObservation(() => {}, { before() { if (fail) throw Error("fixture observer refused"); }, after() {} });
  let op: ReturnType<typeof operation> | undefined;
  let releaseOther: (() => void) | undefined;
  try {
    f.proxy.stop(); // Immediate observation; retain the gate created for this relay.
    const observed = f.result(); await expect(observed).rejects.toThrow("fixture observer refused"); fail = false;
    // The authority callback isolates gate failure from the scope monitor's stop.
    releaseOther = control.relayStarted("pylos", { eligible: () => false, allowed: () => true }, new AbortController().signal);
    const other = control.requestStarted("pylos");
    expect(other.dispatch(), "ANOTHER_TURN_IS_NOT_POISONED").toBe(true); expect(await other.responseReady()).toBe(true); other.close();
    op = operation(f);
    expect(op.dispatch(), "REJECTED_OBSERVATION_NEVER_OPENS_ITS_GATE").toBe(false);
    expect(await op.responseReady(), "REJECTED_OBSERVATION_NEVER_OPENS_ITS_GATE").toBe(false);
  } finally { fail = false; unsubscribe(); releaseOther?.(); op?.finish("cancelled"); await f.close(); }
});

test("nothing pending dispatches synchronously without joining journal work (T9)", async () => {
  const f = await fixture(), blocked = hold(f); let op: ReturnType<typeof operation> | undefined;
  try {
    const unrelated = f.journal.observe(); await blocked.entered; op = operation(f);
    expect(op.dispatch(), "EMPTY_GATE_DISPATCH_IS_A_SYNCHRONOUS_BOOLEAN").toBe(true);
    blocked.release(); await unrelated;
  } finally { blocked.restore(); op?.finish("cancelled"); await f.close(); }
});

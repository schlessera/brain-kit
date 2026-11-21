import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startInferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { body, fixture, send } from "./helpers/deferred-freeze-fixture";

test("eligible result leaves the worker running until full request dispatch; response waits for committed observation", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), dispatched = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint;
  let upstream = 0, delivered = false;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; expect(f.frozen, "STOP_CONFIRMED_BEFORE_DISPATCH").toBe(true); dispatched.resolve(); return new Response("Ithaca"); } });
  const responseBoundary = Promise.withResolvers<void>();
  let responseGateSettled = false;
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: {
    inference(...args) {
      const operation = f.proxy.inference(...args);
      return { ...operation, responseReady() {
        const ready = operation.responseReady();
        void ready.then(() => { responseGateSettled = true; });
        responseBoundary.resolve(); return ready;
      } };
    },
  } });
  try {
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    writeFileSync(join(f.brain, "note.md"), "Penelope");
    const observed = f.result();
    expect(f.frozen, "ELIGIBLE_RESULT_DEFERS_HOLD").toBe(false);
    const response = send(relay.socketPath).then(value => { delivered = true; return value; });
    void response.catch(() => {});
    await entered.promise; await dispatched.promise; await responseBoundary.promise;
    await Promise.resolve();
    expect(responseGateSettled, "RESPONSE_CANNOT_PRECEDE_OBSERVATION_COMMIT").toBe(false);
    expect(delivered).toBe(false);
    expect(upstream).toBe(1);
    release.resolve(); await observed;
    expect(await response).toEqual({ status: 200, bytes: 6 });
    expect(f.journal.details("ithaca", "voyage")!.changes.map(change => change.path)).toEqual(["note.md"]);
    expect(f.frozen).toBe(false);
  } finally { release.resolve(); f.native.manager.checkpoint = checkpoint; relay.stop(); origin.stop(true); await f.close(); }
});

for (const boundary of ["deadline", "new tool", "new worker", "periodic", "abort", "finish", "shutdown"] as const) {
  test(`${boundary} claims an armed result exactly once and retains its observation`, async () => {
    const f = await fixture(); let observations = 0;
    const unsubscribe = f.journal.onObservation(() => { observations++; });
    try {
      const observed = f.result();
      expect(f.frozen, "ARMED_BOUNDARY_RUNS_UNTIL_CLAIM").toBe(false);
      expect(f.deadlines).toHaveLength(1);
      let terminal: Promise<unknown> | undefined;
      if (boundary === "deadline") f.fireDeadline();
      else if (boundary === "new tool") f.journal.toolStarted("voyage", "sail", "Read", true);
      else if (boundary === "new worker") f.scope.workerStarted("voyage", { freeze: () => true, resume: () => true, kill: () => true, exited: new Promise<number>(() => {}) });
      else if (boundary === "periodic") { f.tick(); terminal = f.journal.idle(); }
      else if (boundary === "abort") f.controller.abort();
      else if (boundary === "finish") terminal = f.journal.finish("voyage");
      else terminal = f.journal.close();
      expect(f.frozen, "INTERRUPTION_RETAINS_BASE_HOLD_POLICY").toBe(boundary !== "abort");
      await observed; await terminal;
      expect(observations, "RESULT_IS_NEVER_COALESCED_WITH_ANOTHER_BOUNDARY").toBe(boundary === "periodic" || boundary === "finish" ? 2 : 1);
      expect(f.deadlines.filter(item => !item.cancelled)).toHaveLength(0);
    } finally { unsubscribe(); await f.close(); }
  });
}

for (const uncertainty of ["sibling", "subagent parent", "second session", "unknown call", "request in flight"] as const) {
  test(`${uncertainty} keeps the synchronous per-result hold`, async () => {
    const f = await fixture();
    let operation: ReturnType<typeof f.proxy.inference> | undefined;
    try {
      if (uncertainty === "sibling" || uncertainty === "subagent parent") f.journal.toolStarted("voyage", "other", uncertainty === "sibling" ? "Read" : "Agent", true);
      if (uncertainty === "second session") await f.journal.begin("pylos", { sessionId: null, actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {});
      if (uncertainty === "request in flight") operation = f.proxy.inference("POST", new URL("http://127.0.0.1/v1/messages"), new AbortController().signal);
      const observed = uncertainty === "unknown call" ? f.journal.toolEnded("voyage", "unknown") : f.result();
      expect(f.frozen, "UNKNOWN_EVIDENCE_USES_IMMEDIATE_HOLD").toBe(true);
      expect(f.deadlines).toHaveLength(0);
      await observed;
    } finally { operation?.finish("cancelled"); await f.close(); }
  });
}

for (const requestKind of ["token count", "title", "wrong result", "parallel results", "retry without result", "invalid JSON"] as const) {
  test(`${requestKind} commits the immediate observation before dispatch`, async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const checkpoint = f.native.manager.checkpoint;
    let upstream = 0;
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; return new Response("Ithaca"); } });
    const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages", "/v1/messages/count_tokens"], credentials: {}, egress: f.proxy });
    try {
      f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
      const observed = f.result();
      const value = JSON.parse(body());
      if (requestKind === "title") delete value.tools;
      if (requestKind === "parallel results") value.messages.at(-1).content.push({ type: "tool_result", tool_use_id: "sail", content: "Ithaca" });
      if (requestKind === "retry without result") value.messages.pop();
      const content = requestKind === "invalid JSON" ? "{" : requestKind === "wrong result" ? body("sail") : JSON.stringify(value);
      const response = send(relay.socketPath, content, requestKind === "token count" ? "/v1/messages/count_tokens" : "/v1/messages");
      await entered.promise;
      expect(upstream, "AMBIGUOUS_REQUEST_CANNOT_OVERTAKE_VERDICT").toBe(0);
      release.resolve(); await observed;
      expect((await response).status).toBe(200);
      expect(upstream).toBe(1);
    } finally { release.resolve(); f.native.manager.checkpoint = checkpoint; relay.stop(); origin.stop(true); await f.close(); }
  });
}

for (const ack of [false, undefined] as const) {
  test(`a ${String(ack)} stop receipt falls back to the base immediate hold`, async () => {
    const f = await fixture(); let upstream = 0;
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; return new Response("Ithaca"); } });
    const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: f.proxy });
    try {
      f.ack(ack);
      const observed = f.result();
      let committed = false; void observed.then(() => { committed = true; }, () => {});
      expect((await send(relay.socketPath)).status, "UNCONFIRMED_STOP_FALLS_BACK_WITHOUT_NEW_REFUSAL").toBe(200);
      await observed; expect(committed).toBe(true);
      expect(upstream).toBe(1);
      expect(f.controller.signal.aborted).toBe(false);
      expect(f.journal.summary("voyage").state, "LEGACY_STOP_RETAINS_BASE_JOURNAL_BEHAVIOR").toBe("recording");
    } finally { relay.stop(); origin.stop(true); await f.close(); }
  });
}

test("a deferred cap commits its pause and refusal before any response body reaches the worker", async () => {
  const f = await fixture(1); let upstream = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; return new Response("must stay withheld"); } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: f.proxy });
  try {
    writeFileSync(join(f.brain, "note.md"), "Penelope");
    const observed = f.result();
    const response = await send(relay.socketPath); await observed;
    expect(upstream, "ONE_REQUEST_MAY_PRECEDE_SCOPE_VERDICT").toBe(1);
    expect(response.status, "CAP_REFUSES_THE_IN_FLIGHT_RESPONSE").toBe(403);
    expect(f.frozen).toBe(true);
    const row = f.db.query("SELECT summary FROM turn_scope WHERE turn_id='voyage'").get() as { summary: string };
    expect(JSON.parse(row.summary).receipts).toMatchObject([{ dimension: "files_changed", state: "paused", frozen: true }]);
    expect(f.resumes).toBe(0);
  } finally { relay.stop(); origin.stop(true); await f.close(); }
});

test("a second result gets a separate observation rather than replacing the armed boundary", async () => {
  const f = await fixture(); let observations = 0;
  f.journal.onObservation(() => { observations++; });
  try {
    const first = f.result("loom"), second = f.result("sail");
    expect(f.frozen).toBe(true);
    await first; await second;
    expect(observations, "BOTH_RESULT_BOUNDARIES_COMMIT").toBe(2);
    expect(f.deadlines).toHaveLength(1);
  } finally { await f.close(); }
});

test("receiving headers or a partial request body cannot stop the sending worker", async () => {
  const f = await fixture(), admitted = Promise.withResolvers<void>();
  let upstream = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; return new Response("Ithaca"); } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: {
    inference(...args) { const operation = f.proxy.inference(...args); return { ...operation, async admit() { const allowed = await operation.admit(); admitted.resolve(); return allowed; } }; },
  } });
  let outgoing: ReturnType<typeof import("node:http")["request"]> | undefined;
  try {
    const observed = f.result();
    const { request } = await import("node:http");
    const completed = new Promise<number>((resolve, reject) => {
      outgoing = request({ socketPath: relay.socketPath, path: "/v1/messages", method: "POST" }, response => {
        response.resume(); response.on("error", reject); response.on("end", () => resolve(response.statusCode!));
      }); outgoing.on("error", reject); outgoing.write(body().slice(0, 10));
    });
    await admitted.promise;
    expect(f.frozen, "PARTIAL_REQUEST_MUST_REMAIN_WRITABLE").toBe(false);
    expect(upstream).toBe(0);
    outgoing!.end(body().slice(10));
    expect(await completed).toBe(200); await observed;
    expect(upstream).toBe(1);
  } finally { outgoing?.destroy(); relay.stop(); origin.stop(true); await f.close(); }
});

test("a fallback during the final admission waits for the verdict and forwards without retry", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint; let upstream = 0, fences = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; return new Response("Ithaca"); } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: {
    inference(...args) { const operation = f.proxy.inference(...args); return { ...operation, async admit() {
      if (++fences === 2) f.fireDeadline();
      return operation.admit();
    } }; },
  } });
  try {
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    const observed = f.result(), response = send(relay.socketPath); void response.catch(() => {});
    await entered.promise;
    expect(upstream, "FALLBACK_RETAINS_PRIOR_VERDICT_FENCE").toBe(0);
    release.resolve(); await observed;
    expect((await response).status, "FALLBACK_NEEDS_NO_PROVIDER_RETRY").toBe(200);
    expect(upstream).toBe(1); expect(fences).toBe(2);
  } finally { release.resolve(); f.native.manager.checkpoint = checkpoint; relay.stop(); origin.stop(true); await f.close(); }
});

test("a parallel arrival after arming returns to the immediate observation path", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint; let upstream = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; return new Response("Ithaca"); } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: f.proxy });
  let parallel: ReturnType<typeof f.proxy.inference> | undefined;
  try {
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    const observed = f.result();
    parallel = f.proxy.inference("POST", new URL("/v1/messages", origin.url), new AbortController().signal);
    const response = send(relay.socketPath); void response.catch(() => {});
    await entered.promise;
    expect(upstream, "PARALLEL_REQUESTS_DO_NOT_SPECULATE").toBe(0);
    release.resolve(); await observed;
    expect((await response).status).toBe(200); expect(upstream).toBe(1);
  } finally { release.resolve(); parallel?.finish("cancelled"); f.native.manager.checkpoint = checkpoint; relay.stop(); origin.stop(true); await f.close(); }
});

test("a deferred scope refusal waits for its offloop FULL pause record before answering the relay", async () => {
  const f = await fixture(1, undefined, true);
  const heldWriter = await import("./fixtures/held-publication-writer");
  const channel = f.writer!.channel(heldWriter, {}); await channel.ready;
  const entered = new Int32Array(new SharedArrayBuffer(4)), release = new Int32Array(new SharedArrayBuffer(4));
  let held: Promise<unknown> | undefined, responseGateSettled = false;
  const boundary = Promise.withResolvers<void>();
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: {
    inference(...args) { const operation = f.proxy.inference(...args); return { ...operation, responseReady() {
      const ready = operation.responseReady(); void ready.then(() => { responseGateSettled = true; }); boundary.resolve(); return ready;
    } }; },
  } });
  try {
    // Insert an actual held FULL transaction ahead of the scope observer's
    // save. The journal version is durable, but the cap pause is not yet.
    f.beforeScope(() => { held ??= channel.call("hold", entered, release); });
    writeFileSync(join(f.brain, "note.md"), "Penelope");
    const observed = f.result(), response = send(relay.socketPath); void response.catch(() => {});
    const waiting = Atomics.waitAsync(entered, 0, 0); if (waiting.async) await waiting.value;
    expect(Atomics.load(entered, 0)).toBe(1);
    await boundary.promise; await Promise.resolve();
    expect(responseGateSettled, "SCOPE_REFUSAL_CANNOT_PRECEDE_FULL_COMMIT").toBe(false);
    const prior = f.db.query("SELECT summary FROM turn_scope WHERE turn_id='voyage'").get() as { summary: string };
    expect(JSON.parse(prior.summary).receipts, "HELD_PAUSE_IS_NOT_DURABLE_YET").toEqual([]);
    Atomics.store(release, 0, 1); Atomics.notify(release, 0); await held; await observed;
    expect((await response).status).toBe(403);
    const saved = f.db.query("SELECT summary FROM turn_scope WHERE turn_id='voyage'").get() as { summary: string };
    expect(JSON.parse(saved.summary).receipts).toMatchObject([{ state: "paused", dimension: "files_changed" }]);
  } finally { Atomics.store(release, 0, 1); Atomics.notify(release, 0); await held; f.beforeScope(() => {}); relay.stop(); origin.stop(true); await f.close(); }
});

import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startInferenceRelay } from "@schlessera/brain-ui-sdk/internal";
import { MAX_INFERENCE_REQUEST_BYTES } from "../../ui-sdk/src/server/inference-relay";
import { journalInference } from "../src/brain/journal-inference";
import { body, fixture, send } from "./helpers/deferred-freeze-fixture";

for (const routes of [["/v1/responses"], ["/chat/completions"]]) test(`unsupported relay ${routes[0]} never arms (F13)`, async () => {
  const f = await fixture();
  const relay = startInferenceRelay({ upstream: "http://127.0.0.1", routes, credentials: {}, egress: f.proxy });
  try {
    const observed = f.result();
    expect(f.frozen, "UNSUPPORTED_RELAY_USES_IMMEDIATE_HOLD").toBe(true); await observed;
    expect(f.deadlines).toHaveLength(0);
  } finally { relay.stop(); await f.close(); }
});

test("an ambiguous call identity keeps later results immediate (F5)", async () => {
  const f = await fixture();
  try {
    f.journal.toolStarted("voyage", "twin", "Write", true);
    f.journal.toolStarted("voyage", "twin", "Write", true);
    await f.journal.toolEnded("voyage", "twin");
    const observed = f.result("sail");
    expect(f.frozen, "AMBIGUITY_LATCH_SURVIVES_CALL_ENTRY_DELETION").toBe(true); await observed;
  } finally { await f.close(); }
});

for (const phase of ["arming", "dispatch"] as const) test(`partial coverage forbids deferral at ${phase} (F7)`, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: f.proxy });
  try {
    if (phase === "arming") await f.journal.writeOperation([{ sql: "UPDATE turn_journal_turns SET state='partial' WHERE turn_id=?", params: ["voyage"] }]);
    const observed = f.result();
    if (phase === "arming") {
      expect(f.frozen, "PARTIAL_COVERAGE_NEVER_ARMS").toBe(true); await observed;
    } else {
      await f.journal.writeOperation([{ sql: "UPDATE turn_journal_turns SET state='partial' WHERE turn_id=?", params: ["voyage"] }]);
      f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
      const operation = f.proxy.inference("POST", new URL("/v1/messages", origin.url), new AbortController().signal);
      try {
        let prepared = false;
        const preparing = operation.prepareDispatch(Buffer.from(body())).then(value => { prepared = true; return value; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(prepared, "DISPATCH_RECHECKS_PARTIAL_COVERAGE").toBe(false);
        await entered.promise; release.resolve(); await preparing; await observed;
      } finally { operation.finish("cancelled"); }

    }
  } finally { release.resolve(); f.native.manager.checkpoint = checkpoint; relay.stop(); origin.stop(true); await f.close(); }
});

test("a second inference arrival remains ambiguous after it disconnects (F11)", async () => {
  const f = await fixture();
  let first: ReturnType<typeof f.proxy.inference> | undefined, second: typeof first;
  try {
    const observed = f.result();
    first = f.proxy.inference("POST", new URL("http://127.0.0.1/v1/messages"), new AbortController().signal);
    second = f.proxy.inference("POST", new URL("http://127.0.0.1/v1/messages"), new AbortController().signal);
    second.finish("cancelled");
    expect(f.frozen, "SECOND_ARRIVAL_FLUSHES_SYNCHRONOUSLY").toBe(true); await observed;
    first.finish("cancelled");
    const later = f.result("sail"); expect(f.frozen, "SECOND_ARRIVAL_LATCH_IS_STICKY").toBe(true); await later;
  } finally { first?.finish("cancelled"); second?.finish("cancelled"); await f.close(); }
});

test("elapsed deadline takes the immediate path before its timer callback runs (D1)", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: f.proxy });
  try {
    const observed = f.result(); f.elapseDeadline(51);
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    const operation = f.proxy.inference("POST", new URL("/v1/messages", origin.url), new AbortController().signal);
    try {
      let prepared = false;
      const preparing = operation.prepareDispatch(Buffer.from(body())).then(value => { prepared = true; return value; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(prepared, "ELAPSED_DEADLINE_CANNOT_SPECULATE").toBe(false);
      await entered.promise; release.resolve(); await preparing; await observed;
    } finally { operation.finish("cancelled"); }
  } finally { release.resolve(); f.native.manager.checkpoint = checkpoint; relay.stop(); origin.stop(true); await f.close(); }
});

for (const cause of ["credentials", "body size", "byte cap", "admission"] as const) test(`the ${cause} refusal joins its result observation (F2)`, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: async () => { if (cause === "credentials") throw Error("fixture unavailable"); return {}; }, egress: {
    ...f.proxy, inference(...args) { const operation = f.proxy.inference(...args); return { ...operation,
      charge: cause === "byte cap" ? () => false : operation.charge,
      admit: cause === "admission" ? async () => false : operation.admit,
    }; },
  } });
  try {
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    const observed = f.result();
    const response = send(relay.socketPath, body(), "/v1/messages", cause === "body size" ? { "content-length": String(MAX_INFERENCE_REQUEST_BYTES + 1) } : {});
    void response.catch(() => {});
    const first = await Promise.race([entered.promise.then(() => "observation"), response.then(() => "reply")]);
    expect(first, "ALL_RELAY_ANSWERS_JOIN_THE_RESULT_OBSERVATION").toBe("observation");
    release.resolve(); await observed;
    expect((await response).status).toBe(cause === "credentials" ? 503 : cause === "body size" ? 413 : 403);
  } finally { release.resolve(); f.native.manager.checkpoint = checkpoint; relay.stop(); origin.stop(true); await f.close(); }
});

test("Continue before headers cannot release the response of a capped observation (F1)", async () => {
  const f = await fixture(1), headers = Promise.withResolvers<void>();
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { await headers.promise; return new Response("withhold"); } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: f.proxy });
  try {
    writeFileSync(join(f.brain, "note.md"), "Penelope");
    const observed = f.result(), response = send(relay.socketPath); void response.catch(() => {}); await observed;
    const receipt = f.journal.summary("voyage").scope!.receipts.at(-1)!;
    expect((await f.scope.decide({ type: "scope_decision", turnId: "voyage", sessionId: "ithaca", eventId: receipt.eventId, submissionId: "captain", action: "continue" }, true)).state).toBe("accepted");
    headers.resolve();
    expect((await response).status, "CAPPED_REQUEST_VERDICT_SURVIVES_CONTINUE").toBe(403);
    expect((await send(relay.socketPath)).status, "LATER_REQUEST_DOES_NOT_INHERIT_THE_OLD_VERDICT").toBe(200);
  } finally { headers.resolve(); relay.stop(); origin.stop(true); await f.close(); }
});

test("unrelated global journal work neither delays nor refuses an ordinary inference (F8, X2)", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint;
  let operation: ReturnType<typeof f.proxy.inference> | undefined;
  try {
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    const unrelated = f.journal.observe(); await entered.promise;
    operation = f.proxy.inference("POST", new URL("http://127.0.0.1/v1/messages"), new AbortController().signal);
    let prepared = false;
    const preparing = operation.prepareDispatch(Buffer.from(body())).then(value => { prepared = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(prepared, "ORDINARY_INFERENCE_DOES_NOT_JOIN_GLOBAL_TAIL").toBe(true);
    expect(await preparing).toBe(true);
    expect(operation.dispatch(), "ORDINARY_DISPATCH_RETAINS_BASE_COMMIT_BEHAVIOR").toBe(true);
    release.resolve(); await unrelated;
  } finally { release.resolve(); operation?.finish("cancelled"); f.native.manager.checkpoint = checkpoint; await f.close(); }
});

for (const kind of ["immediate", "periodic", "finish", "admission"] as const) test(`${kind} holds do not gain scope-settlement waits (F9)`, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const control = journalInference(f.journal)!, settle = control.settleScope;
  try {
    control.settleScope = async () => { entered.resolve(); await release.promise; };
    let work: Promise<unknown>;
    if (kind === "immediate") { f.proxy.stop(); work = f.result(); }
    else if (kind === "periodic") { f.tick(); work = f.journal.idle(); }
    else if (kind === "finish") work = f.journal.finish("voyage");
    else work = f.journal.begin("pylos", { sessionId: null, actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {});
    const first = await Promise.race([work.then(() => "complete"), entered.promise.then(() => "scope wait")]);
    expect(first, "BASE_HOLD_SCHEDULE_HAS_NO_NEW_SCOPE_WAIT").toBe("complete");
  } finally { release.resolve(); control.settleScope = settle; await f.close(); }
});

test("periodic capture preserves the base skip for ended authority (X3)", async () => {
  const f = await fixture();
  try { f.controller.abort(); await f.journal.observe(); expect(f.stops, "ENDED_AUTHORITY_IS_NOT_NEWLY_FROZEN").toBe(0); }
  finally { await f.close(); }
});


test("a non-deferred dispatch retains base commit behavior during another hold (X2)", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint;
  let operation: ReturnType<typeof f.proxy.inference> | undefined;
  try {
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    const unrelated = f.journal.observe(); await entered.promise;
    operation = f.proxy.inference("POST", new URL("http://127.0.0.1/v1/messages"), new AbortController().signal);
    expect(operation.dispatch(), "ORDINARY_DISPATCH_HAS_NO_NEW_HOLD_REFUSAL").toBe(true);
    release.resolve(); await unrelated;
  } finally { release.resolve(); operation?.finish("cancelled"); f.native.manager.checkpoint = checkpoint; await f.close(); }
});


test("null scope measurements take the immediate path even with a recording journal (F7)", async () => {
  const f = await fixture();
  try {
    await f.journal.writeOperation([{ sql: "UPDATE turn_journal_turns SET state='partial' WHERE turn_id=?", params: ["voyage"] }]);
    await f.journal.observe();
    await f.journal.writeOperation([{ sql: "UPDATE turn_journal_turns SET state='recording' WHERE turn_id=?", params: ["voyage"] }]);
    const observed = f.result();
    expect(f.frozen, "UNKNOWN_SCOPE_MEASUREMENTS_USE_IMMEDIATE_HOLD").toBe(true); await observed;
  } finally { await f.close(); }
});

test("the synchronous dispatch predicate rechecks coverage after preparation (D1)", async () => {
  const f = await fixture();
  let operation: ReturnType<typeof f.proxy.inference> | undefined;
  try {
    const observed = f.result();
    operation = f.proxy.inference("POST", new URL("http://127.0.0.1/v1/messages"), new AbortController().signal);
    expect(await operation.prepareDispatch(Buffer.from(body()))).toBe(true);
    await f.journal.writeOperation([{ sql: "UPDATE turn_journal_turns SET state='partial' WHERE turn_id=?", params: ["voyage"] }]);
    expect(operation.dispatch(), "DISPATCH_HAS_THE_SAME_DEFERRAL_PREDICATE").toBe(false);
    await observed;
  } finally { operation?.finish("cancelled"); await f.close(); }
});

test("a token-count request cannot dispatch after its immediate observation hit a cap (R2 A1)", async () => {
  const f = await fixture(1); let upstream = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstream++; return new Response("Ithaca"); } });
  const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages", "/v1/messages/count_tokens"], credentials: {}, egress: f.proxy });
  try {
    writeFileSync(join(f.brain, "note.md"), "Penelope");
    const observed = f.result(), response = send(relay.socketPath, body(), "/v1/messages/count_tokens");
    expect((await response).status).toBe(403); await observed;
    expect(upstream, "CAPPED_IMMEDIATE_BOUNDARY_CANNOT_DISPATCH_AUXILIARY_REQUEST").toBe(0);
    expect(f.journal.summary("voyage").scope!.receipts.at(-1)).toMatchObject({ dimension: "files_changed", state: "paused" });
  } finally { relay.stop(); origin.stop(true); await f.close(); }
});

for (const phase of ["arming", "dispatch"] as const) test(`a predicate read failure takes the immediate hold at ${phase} (R2 A2)`, async () => {
  const f = await fixture();
  const saved = (f.db.query("SELECT summary FROM turn_scope WHERE turn_id='voyage'").get() as { summary: string }).summary;
  let observed: Promise<void> | undefined, operation: ReturnType<typeof f.proxy.inference> | undefined;
  try {
    if (phase === "dispatch") {
      observed = f.result(); void observed.catch(() => {});
      operation = f.proxy.inference("POST", new URL("http://127.0.0.1/v1/messages"), new AbortController().signal);
      expect(await operation.prepareDispatch(Buffer.from(body()))).toBe(true);
    }
    f.db.query("UPDATE turn_scope SET summary='{' WHERE turn_id='voyage'").run();
    expect(() => {
      if (phase === "arming") { observed = f.result(); void observed.catch(() => {}); }
      else expect(operation!.dispatch()).toBe(false);
    }, "PREDICATE_READ_FAILURE_RETURNS_TO_IMMEDIATE_HOLD").not.toThrow();
    expect(f.frozen, "PREDICATE_READ_FAILURE_SYNCHRONOUSLY_TAKES_HOLD").toBe(true);
    expect(observed, "REQUIRED_OBSERVATION_RETURNS_A_PROMISE").toBeInstanceOf(Promise);
    // Repair the read before the queued capture starts. The guard failure
    // must still keep this turn immediate after a healthy observation.
    f.db.query("UPDATE turn_scope SET summary=? WHERE turn_id='voyage'").run(saved);
    await observed!;
    operation?.finish("cancelled");
    const later = f.result("sail");
    expect(f.frozen, "PREDICATE_READ_FAILURE_LATCH_REMAINS_IMMEDIATE_ONLY").toBe(true); await later;
  } finally {
    f.db.query("UPDATE turn_scope SET summary=? WHERE turn_id='voyage'").run(saved);
    operation?.finish("cancelled"); await f.close();
  }
});

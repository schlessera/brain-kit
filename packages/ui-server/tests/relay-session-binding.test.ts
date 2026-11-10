import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { startInferenceRelay, startProviderRelay } from "@schlessera/brain-ui-sdk/internal";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeBridge } from "../src/ws/bridge";
import { WsHost } from "../src/ws/host";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { prepareTurnEgress } from "../src/brain/turn-egress";
import * as probe from "./fixtures/relay-binding-probe";
import type { AdmissionSafetySnapshot } from "../../ui-sdk/src/server/admission-safety";

for (const kind of ["inference", "provider"] as const) for (const releaseAt of [0, 2, 3]) test(`${kind} joins own session binding at safety read ${releaseAt}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-binding-probe-"));
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  const store = createActivityStore(db, { writer: "odysseus" });
  const catalog = createSessionCatalog(() => db, undefined, undefined, { writer, governance: writes, pricing: { resolve: () => null }, store });
  const host = new WsHost({ brainPath: root, catalog, registry: createStaticBackendRegistry([makeFakeBackend({ id: "claude" })], "claude"),
    isPrincipalAuthorized: () => true, activity: { store, stream: createActivityStream(store), governanceDb: db, governanceWrites: writes } });
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  const controller = new AbortController();
  const turn = { turnId: "voyage", requestId: "voyage-request", principalId: "odysseus", authorization, sessionId: null, startedAt: Date.now(),
    abortController: controller, queue: [] } as unknown as import("../src/ws/turns").RunningTurn;
  const channel = writer.channel(probe, undefined); await channel.ready;
  const gate = new Int32Array(new SharedArrayBuffer(4)), entered = new Int32Array(new SharedArrayBuffer(4)), done = new Int32Array(new SharedArrayBuffer(4));
  const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
  let held: Promise<unknown> | undefined, marked: Promise<unknown> | undefined, requests = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ content: [] }); } });
  let proxy: Awaited<ReturnType<typeof prepareTurnEgress>> | undefined;
  let relay: ReturnType<typeof startInferenceRelay> | ReturnType<typeof startProviderRelay> | undefined;
  const samples: unknown[] = [];
  try {
    await writes.safetyBegin({ turnId: "voyage", bindingId: crypto.randomUUID(), sessionId: null, principalId: "odysseus", backendId: "claude", at: 0 });
    await writes.safetyReady("voyage", "claude", 1);
    const bridge = await makeBridge(host, turn, { backendId: "claude", promptText: "Plan the return to Ithaca." });
    const safety = bridge.admissionSafety!;
    const original = safety.read.bind(safety);
    safety.read = () => {
      if (samples.length + 1 === releaseAt) {
        release();
        expect(Atomics.wait(done, 0, 0, 5000), "BINDING_WRITER_COMMITTED_WITHOUT_EVENT_LOOP_PROGRESS").not.toBe("timed-out");
      }
      const value = original(); samples.push({ ...value }); return value;
    };
    proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }), bridge,
      controller, turnId: "voyage", sessionId: () => turn.sessionId, model: () => null, profile: "governed", origin: "interactive", governanceDb: db, governanceWrites: writes,
      record: event => writes.record(event) });
    held = channel.call("hold", gate, entered);
    if (Atomics.load(entered, 0) === 0) await Atomics.waitAsync(entered, 0, 0, 5000).value;
    expect(Atomics.load(entered, 0)).toBe(1);
    bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
    marked = channel.call("committed", done);
    expect(turn.sessionId, "REAL_EMISSION_ANNOUNCES_SESSION_BEFORE_BINDING_COMMITS").toBe("ithaca");
    if (releaseAt === 0) { release(); await catalog.settled!(); await marked; }
    const enteredAdmission = Promise.withResolvers<void>();
    const observeOperation = (operation: ReturnType<NonNullable<typeof proxy>["inference"]>) => ({ ...operation, admit() {
      enteredAdmission.resolve(); return operation.admit();
    } });
    relay = kind === "inference"
      ? startInferenceRelay({ upstream: upstream.url.origin, routes: ["/v1/messages"], credentials: { "x-api-key": "odysseus-offline-only-key" },
          egress: { inference: (...args) => observeOperation(proxy!.inference(...args)) } })
      : startProviderRelay({ origins: new Map([["ODYSSEUS_RELAY_KEY", [upstream.url.origin]]]), credential: () => "odysseus-offline-only-key",
          egress: { relayed: (...args) => observeOperation(proxy!.relayed(...args)) } });
    const responsePending = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request({ socketPath: relay!.socketPath, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-brain-provider": "anthropic", "x-brain-provider-key": "ODYSSEUS_RELAY_KEY", "x-brain-provider-origin": upstream.url.origin } }, incoming => {
        const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(chunk)); incoming.on("error", reject);
        incoming.on("end", () => resolve({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString() }));
      }); outgoing.on("error", reject); outgoing.end(JSON.stringify({ model: "odysseus", messages: [] }));
    });
    await enteredAdmission.promise;
    // A fixed host waits before its first read. The baseline reaches the
    // controlled second/third read first, during the same microtask drain.
    await new Promise<void>(resolve => setImmediate(() => { release(); resolve(); }));
    const response = await responsePending;
    await proxy.settled();
    const egress = db.query("SELECT json_extract(payload,'$.outcome') outcome,json_extract(payload,'$.reason') reason FROM governance_events WHERE kind='egress_connection'").all();
    expect(response.status, "HEALTHY_OWN_BINDING_JOINS_BEFORE_INFERENCE_SNAPSHOT").toBe(200);
    expect(requests, "EXACTLY_ONE_PROVIDER_DISPATCH_AFTER_OWN_BINDING").toBe(1);
    expect(egress, "HEALTHY_BINDING_HAS_ONE_COMPLETED_EGRESS").toEqual([{ outcome: "completed", reason: null }]);
  } finally {
    release(); await held?.catch(() => {}); await marked?.catch(() => {}); await relay?.stop(); proxy?.stop(); await proxy?.settled(); upstream.stop(true);
    authorization.release(); await catalog.settled!(); host.close(); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

async function adverseFixture(kind: "inference" | "provider", finalWait = false) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-binding-adverse-"));
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  const store = createActivityStore(db, { writer: "odysseus" });
  const catalog = createSessionCatalog(() => db, undefined, undefined,
    { writer, governance: writes, pricing: { resolve: () => null }, store });
  let authorized = true, requests = 0;
  const host = new WsHost({ brainPath: root, catalog, registry: createStaticBackendRegistry([makeFakeBackend({ id: "claude" })], "claude"),
    isPrincipalAuthorized: () => authorized, activity: { store, stream: createActivityStream(store), governanceDb: db, governanceWrites: writes } });
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  const controller = new AbortController();
  const turn = { turnId: "voyage", requestId: "voyage-request", principalId: "odysseus", authorization, sessionId: null, startedAt: Date.now(),
    abortController: controller, queue: [] } as unknown as import("../src/ws/turns").RunningTurn;
  await writes.safetyBegin({ turnId: "voyage", bindingId: crypto.randomUUID(), sessionId: null, principalId: "odysseus", backendId: "claude", at: 0 });
  await writes.safetyReady("voyage", "claude", 1);
  await writes.safetyBegin({ turnId: "other-voyage", bindingId: crypto.randomUUID(), sessionId: null, principalId: "odysseus", backendId: "claude", at: 0 });
  await writes.safetyReady("other-voyage", "claude", 1);
  const bridge = await makeBridge(host, turn, { backendId: "claude", promptText: "Plan the return to Ithaca." });
  const reads: AdmissionSafetySnapshot[] = [], read = bridge.admissionSafety!.read.bind(bridge.admissionSafety);
  bridge.admissionSafety!.read = () => { const value = read(); reads.push(value); return value; };
  const channel = writer.channel(probe, undefined); await channel.ready;
  const pending: Promise<unknown>[] = [], releases: (() => void)[] = [];
  const hold = async () => {
    const gate = new Int32Array(new SharedArrayBuffer(4)), entered = new Int32Array(new SharedArrayBuffer(4));
    const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
    releases.push(release); const committed = channel.call("hold", gate, entered); pending.push(committed); void committed.catch(() => {});
    if (!Atomics.load(entered, 0)) await Atomics.waitAsync(entered, 0, 0, 5000).value;
    expect(Atomics.load(entered, 0), "ADVERSE_FIXTURE_HOLDS_REAL_FULL_WRITER").toBe(1);
    return { release, committed };
  };
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ content: [] }); } });
  const proxy = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }), bridge, controller,
    turnId: "voyage", sessionId: () => turn.sessionId, model: () => null, profile: "governed", origin: "interactive", governanceDb: db,
    governanceWrites: writes, record: event => writes.record(event) });
  const enteredAdmission = Promise.withResolvers<void>(), finalReached = Promise.withResolvers<void>(), releaseFinal = Promise.withResolvers<void>();
  const observeOperation = (operation: ReturnType<typeof proxy.inference>) => ({ ...operation, admit() {
    enteredAdmission.resolve(); return operation.admit();
  } });
  let providerAdmissions = 0;
  const relay = kind === "inference"
    ? startInferenceRelay({ upstream: upstream.url.origin, routes: ["/v1/messages"], credentials: async () => {
        if (finalWait) { finalReached.resolve(); await releaseFinal.promise; }
        return { "x-api-key": "odysseus-offline-only-key" };
      }, egress: { inference: (...args) => observeOperation(proxy.inference(...args)) } })
    : startProviderRelay({ origins: new Map([["ODYSSEUS_RELAY_KEY", [upstream.url.origin]]]), credential: () => "odysseus-offline-only-key",
        admit: async () => {
          if (++providerAdmissions === 2 && finalWait) { finalReached.resolve(); await releaseFinal.promise; }
          return { allowed: true };
        }, egress: { relayed: (...args) => observeOperation(proxy.relayed(...args)) } });
  return {
    db, writer, writes, turn, bridge, catalog, controller, reads, proxy, hold, host,
    enteredAdmission: enteredAdmission.promise, finalReached: finalReached.promise, releaseFinal: releaseFinal.resolve,
    revoke() { authorized = false; }, requests: () => requests,
    track(work: Promise<unknown>) { pending.push(work); void work.catch(() => {}); },
    announce() { bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true }); },
    send() {
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const body = JSON.stringify({ model: "odysseus", messages: [] });
        const outgoing = request({ socketPath: relay.socketPath, path: "/v1/messages", method: "POST", headers: {
          "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "x-brain-provider": "anthropic",
          "x-brain-provider-key": "ODYSSEUS_RELAY_KEY", "x-brain-provider-origin": upstream.url.origin,
        } }, incoming => {
          const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(chunk)); incoming.on("error", reject);
          incoming.on("end", () => resolve({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString() }));
        }); outgoing.on("error", reject); outgoing.end(body);
      });
    },
    async close() {
      for (const release of releases) release(); releaseFinal.resolve();
      await Promise.allSettled(pending); await relay.stop(); proxy.stop(); await proxy.settled(); upstream.stop(true);
      authorization.release(); await catalog.settled!(); host.close(); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const kind of ["inference", "provider"] as const) {
  for (const mode of ["cancelled", "authority-revoked", "catalog-failed", "deadline"] as const) {
    test(`${kind} refuses ${mode} while its own announced binding is pending`, async () => {
      const f = await adverseFixture(kind), clock = Object.getOwnPropertyDescriptor(Date, "now")!, now = Date.now;
      try {
        if (mode === "catalog-failed") f.db.exec("CREATE TRIGGER refuse_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'Odysseus catalog unavailable'); END");
        const held = await f.hold(); f.announce();
        const response = f.send(); await f.enteredAdmission;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.reads, "NO_ADMISSION_SNAPSHOT_BEFORE_OWN_BINDING_SETTLES").toHaveLength(0);
        expect(f.requests()).toBe(0);
        if (mode === "cancelled") f.controller.abort();
        else if (mode === "authority-revoked") f.revoke();
        else if (mode === "deadline") Object.defineProperty(Date, "now", { ...clock, value: () => now() + 10001 });
        else held.release();
        const result = await response;
        expect(result.status, "FAILED_BINDING_NEVER_DISPATCHES").toBe(mode === "cancelled" ? 499 : 403);
        expect(f.requests(), "FAILED_BINDING_HAS_ZERO_PROVIDER_REQUESTS").toBe(0);
        expect(f.reads, "FAILED_BINDING_NEVER_MINTS_ADMISSION_AUTHORITY").toHaveLength(0);
      } finally { Object.defineProperty(Date, "now", clock); await f.close(); }
    });
  }

  test(`${kind} does not join or exempt an independent pending input after binding`, async () => {
    const f = await adverseFixture(kind);
    try {
      f.announce(); await f.catalog.settled!();
      const held = await f.hold();
      f.track(f.writes.firstTaint({ kind: "taint", turnId: "voyage", sessionId: "ithaca", actor: "interactive", model: null, profile: null,
        payload: { source: "web_fetch", tool: "WebFetch", detail: "Odysseus harbour notice" } }));
      expect(f.writes.recordingAvailable("voyage", "ithaca")).toBe(false);
      const result = await f.send();
      expect(result.status).toBe(403);
      expect(f.requests(), "INDEPENDENT_PENDING_INPUT_NEVER_REACHES_PROVIDER").toBe(0);
      expect(f.reads.some(value => !value.recordingAvailable)).toBe(true);
      held.release();
    } finally { await f.close(); }
  });

  for (const mode of ["recording-loss", "authority-revoked", "changed-scope"] as const) {
    test(`${kind} preserves the final ${mode} fence after initial binding admission`, async () => {
      const f = await adverseFixture(kind, true);
      try {
        f.announce(); await f.catalog.settled!();
        const response = f.send(); await f.finalReached;
        expect(f.reads.length, "INITIAL_ADMISSION_SUCCEEDED_BEFORE_FINAL_WAIT").toBeGreaterThanOrEqual(3);
        expect(f.requests()).toBe(0);
        if (mode === "recording-loss") await f.writes.safetyFail("other-voyage");
        else if (mode === "authority-revoked") f.revoke();
        else {
          f.bridge.emit({ type: "session_info", sessionId: "troy", isNew: true });
          await f.catalog.settled!();
        }
        f.releaseFinal();
        expect((await response).status).toBe(403);
        expect(f.requests(), "FINAL_SAFETY_CHANGE_NEVER_REACHES_PROVIDER").toBe(0);
        await f.proxy.settled();
        if (mode === "changed-scope") {
          // A contradictory backend announcement also makes its egress
          // attribution invalid. The existing recorder must stop the turn
          // rather than invent a binding for this terminal denial.
          expect(f.proxy.recordingFailure()).toBeDefined();
          expect(f.controller.signal.aborted).toBe(true);
        } else {
          const reason = mode === "authority-revoked" && kind === "inference" ? "session_binding_unavailable" : "safety_changed";
          expect(f.db.query("SELECT json_extract(payload,'$.reason') reason FROM governance_events WHERE kind='egress_connection'").all())
            .toEqual([{ reason }]);
        }
      } finally { await f.close(); }
    });
  }
}

for (const kind of ["inference", "provider"] as const) test(`${kind} own-binding deadline leaves another healthy turn usable`, async () => {
  const f = await adverseFixture(kind), clock = Object.getOwnPropertyDescriptor(Date, "now")!, now = Date.now;
  let peer: Awaited<ReturnType<typeof prepareTurnEgress>> | undefined;
  let relay: ReturnType<typeof startInferenceRelay> | ReturnType<typeof startProviderRelay> | undefined;
  let requests = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ content: [] }); } });
  try {
    const held = await f.hold(); f.announce();
    const refused = f.send(); await f.enteredAdmission;
    await new Promise<void>(resolve => setImmediate(resolve));
    Object.defineProperty(Date, "now", { ...clock, value: () => now() + 10001 });
    expect((await refused).status, "OWN_BINDING_DEADLINE_REFUSES_ONLY_ITS_REQUEST").toBe(403);
    Object.defineProperty(Date, "now", clock); held.release();
    await held.committed; await f.catalog.settled!(); await f.proxy.settled();
    const controller = new AbortController();
    const turn = { ...f.turn, turnId: "other-voyage", requestId: "pylos-request", sessionId: null, abortController: controller, queue: [] };
    const bridge = await makeBridge(f.host, turn, { backendId: "claude", promptText: "Nestor reads the harbour notice." });
    bridge.emit({ type: "session_info", sessionId: "pylos", isNew: true });
    await f.catalog.settled!();
    peer = await prepareTurnEgress({ policy: resolveGovernancePolicy({ schema_version: 1 }), bridge, controller,
      turnId: turn.turnId, sessionId: () => turn.sessionId, model: () => null, profile: "governed", origin: "interactive",
      governanceDb: f.db, governanceWrites: f.writes, record: event => f.writes.record(event) });
    relay = kind === "inference"
      ? startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: { "x-api-key": "odysseus-offline-only-key" }, egress: peer })
      : startProviderRelay({ origins: new Map([["ODYSSEUS_RELAY_KEY", [origin.url.origin]]]), credential: () => "odysseus-offline-only-key", egress: peer });
    const status = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ model: "odysseus", messages: [] });
      const outgoing = request({ socketPath: relay!.socketPath, path: "/v1/messages", method: "POST", headers: {
        "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "x-brain-provider": "anthropic",
        "x-brain-provider-key": "ODYSSEUS_RELAY_KEY", "x-brain-provider-origin": origin.url.origin,
      } }, incoming => { incoming.resume(); incoming.on("error", reject); incoming.on("end", () => resolve(incoming.statusCode!)); });
      outgoing.on("error", reject); outgoing.end(body);
    });
    expect(status, "OWN_BINDING_DEADLINE_DOES_NOT_LATCH_ANOTHER_TURN").toBe(200);
    expect(requests, "HEALTHY_PEER_DISPATCHES_ONCE_WITHOUT_RETRY").toBe(1);
    expect(f.requests(), "EXPIRED_REQUEST_WAS_NEVER_RETRIED").toBe(0);
  } finally {
    Object.defineProperty(Date, "now", clock);
    await relay?.stop(); peer?.stop(); await peer?.settled(); origin.stop(true); await f.close();
  }
});

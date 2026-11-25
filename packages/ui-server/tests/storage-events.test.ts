import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StorageEvent, StorageEventKind, StorageEventsResponse, StorageMaintenanceReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createStorageHistory, storageBrainKey } from "../src/storage/history-store.js";
import { hashScope, type Aggregate } from "../src/storage/history-model.js";
import { STORAGE_EVENT_LIMITS, readStorageEvents, recordStorageEvent } from "../src/storage/events.js";
import { createStorageCoordinator } from "../src/storage/coordinator.js";
import { createStorageMaintenance } from "../src/storage/maintenance.js";
import { httpContractApp } from "./helpers/http-contract-app.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const start = Date.UTC(2026, 6, 12, 9, 41), MINUTE = 60_000;
const identity = hashScope("Odysseus volume"), scope = hashScope("Odysseus stores");
const TOTAL = 1_000_000_000;
const aggregate = (at: number, available: number, rootScope = scope, id = identity): Aggregate => ({ at, startedAt: at - 10, source: 1, descriptor: ["0.44.0", scope, 1], coverage: 0, reason: 0,
  capacities: [{ descriptor: [id, rootScope], values: [TOTAL, TOTAL - available, available, available, 0, 1, 4096, 2, 8192, 0, 0, 3, 12288] }] });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-events-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "operations.sqlite");
  let db = createUiDb(path), now = start;
  cleanup.push(() => db.close());
  let history = createStorageHistory(db, root, { now: () => now });
  return {
    root, get db() { return db; }, get history() { return history; },
    /** Offers an observation made at `at` and flushes it later, as a slow collection would. */
    observe(at: number, available: number, rootScope = scope) { now = at + 5_000; history.offer(aggregate(at, available, rootScope)); },
    advance(value: number) { now = value; },
    events(query: { identity?: string; since?: number } = {}) { return readStorageEvents(db, history.brain, "odysseus", query); },
    reopen() { history.close(); db.close(); db = createUiDb(path); history = createStorageHistory(db, root, { now: () => now }); },
  };
}
const transitions = (response: StorageEventsResponse) => response.events.filter(event => event.kind === "pressure" && event.phase !== "recovery-started");

test("a warning episode records low → critical → low → observed at the observations' own times and survives restart", () => {
  const f = fixture();
  f.observe(start, 150_000_000);
  f.observe(start + 2 * MINUTE, 80_000_000);
  f.observe(start + 4 * MINUTE, 40_000_000);
  f.observe(start + 6 * MINUTE, 90_000_000);
  f.observe(start + 8 * MINUTE, 90_000_000);
  f.observe(start + 10 * MINUTE, 150_000_000);
  f.observe(start + 12 * MINUTE, 150_000_000);
  expect(f.history.read()!.metadata.state.pressures[0]!.severity).toBe("observed");
  const response = f.events(), first = response.events[0]!;
  expect(transitions(response).map(event => event.kind === "pressure" && [event.phase, event.severity, event.at, event.episode]), "STORAGE_EVENTS_EPISODE_REAL_TIMES").toEqual([
    ["start", "low", start + 2 * MINUTE, first.seq],
    ["step", "critical", start + 4 * MINUTE, first.seq],
    ["step", "low", start + 8 * MINUTE, first.seq],
    ["end", "observed", start + 12 * MINUTE, first.seq],
  ]);
  expect(response.events.flatMap(event => event.kind === "pressure" && event.phase === "recovery-started" ? [[event.severity, event.at]] : []))
    .toEqual([["critical", start + 6 * MINUTE], ["low", start + 10 * MINUTE]]);
  // Pressure.at has advanced past every transition; the start keeps its own time.
  expect(f.history.read()!.metadata.state.pressures[0]!.at).toBe(start + 12 * MINUTE);
  expect(response.events.every(event => event.kind === "pressure" && event.identity === identity)).toBe(true);
  expect(response.paused).toEqual({ pressure: false, refusal: false, scope: false, maintenance: false });
  f.reopen();
  expect(f.events(), "STORAGE_EVENTS_DURABLE_ACROSS_RESTART").toEqual(response);
});

test("an episode open before recording began is never emitted, and the next one is", () => {
  const f = fixture();
  f.observe(start, 40_000_000);
  // The episode above started before this version recorded events.
  f.db.query("DELETE FROM storage_events").run();
  f.observe(start + 2 * MINUTE, 150_000_000);
  f.observe(start + 4 * MINUTE, 150_000_000);
  f.observe(start + 6 * MINUTE, 150_000_000);
  f.observe(start + 8 * MINUTE, 150_000_000);
  expect(f.history.read()!.metadata.state.pressures[0]!.severity).toBe("observed");
  expect(f.events().events, "STORAGE_EVENTS_NO_BACKFILL").toEqual([]);
  f.observe(start + 10 * MINUTE, 80_000_000);
  expect(f.events().events.map(event => event.kind === "pressure" && [event.phase, event.at])).toEqual([["start", start + 10 * MINUTE]]);
});

test("an owner refusal and the warning it starts are distinct events at one time, recorded once until resolved", () => {
  const f = fixture(); f.observe(start, 500_000_000);
  const report = { identity, rootScope: scope, target: hashScope("Odysseus attachment"), resource: "bytes" as const, outcome: "no-space" as const, at: start + 2 * MINUTE };
  f.advance(report.at); f.history.ownerWrite(report);
  f.advance(report.at + MINUTE); f.history.ownerWrite({ ...report, at: report.at + MINUTE });
  f.advance(report.at + 2 * MINUTE); f.history.ownerWrite({ ...report, at: report.at + 2 * MINUTE, outcome: "success" });
  const events = f.events().events;
  expect(events.map(event => [event.kind, event.phase, event.at]), "STORAGE_EVENTS_REFUSAL_TRANSITIONS").toEqual([
    ["refusal", "refused", report.at], ["pressure", "start", report.at], ["refusal", "succeeded", report.at + 2 * MINUTE],
  ]);
  expect(events[0]!.seq, "STORAGE_EVENTS_EQUAL_TIMES_DISTINCT_SEQ").toBeLessThan(events[1]!.seq);
  expect(events[0]).toMatchObject({ identity, target: report.target, resource: "bytes" });
  expect(events[1]).toMatchObject({ severity: "critical" });
});

test("a capacity's store scope change is recorded once with both opaque scopes", () => {
  const f = fixture(), next = hashScope("Odysseus stores and Penelope's loom");
  f.observe(start, 500_000_000);
  f.observe(start + 2 * MINUTE, 500_000_000, next);
  f.observe(start + 4 * MINUTE, 500_000_000, next);
  expect(f.events().events, "STORAGE_EVENTS_SCOPE_CHANGE").toEqual([{ seq: expect.any(Number), at: start + 2 * MINUTE, kind: "scope", identity, phase: "changed", rootScope: next, previousRootScope: scope }]);
  // A warning keeps its original scope while it lasts; its change is still recorded once.
  f.observe(start + 6 * MINUTE, 40_000_000, next);
  f.observe(start + 8 * MINUTE, 40_000_000, scope);
  f.observe(start + 10 * MINUTE, 40_000_000, scope);
  expect(f.events({ since: f.events().events[0]!.seq }).events.filter(event => event.kind === "scope").map(event => event.kind === "scope" && [event.previousRootScope, event.rootScope]))
    .toEqual([[next, scope]]);
});

const synthetic = (kind: StorageEventKind, index: number) => kind === "maintenance"
  ? { kind, phase: "requested" as const, at: start, receipt: `odysseus-synthetic-${String(index).padStart(6, "0")}`, operation: "prune-scratch", principal: "odysseus" }
  : kind === "pressure" ? { kind, phase: "start" as const, at: start, identity, severity: "low" as const }
  : kind === "refusal" ? { kind, phase: "refused" as const, at: start, identity, target: hashScope(index), resource: "bytes" as const }
  : { kind, phase: "changed" as const, at: start, identity, rootScope: hashScope(index), previousRootScope: scope };

test("each kind stops recording at its own limit, keeps earlier events and leaves the other kinds recording", () => {
  const f = fixture(), brain = f.history.brain;
  for (const kind of ["pressure", "refusal", "scope", "maintenance"] as const) {
    for (let index = 0; index < STORAGE_EVENT_LIMITS[kind]; index++) expect(recordStorageEvent(f.db, brain, synthetic(kind, index))).not.toBeNull();
    const before = f.events();
    expect(before.paused[kind], `STORAGE_EVENTS_${kind.toUpperCase()}_PAUSED_AT_LIMIT`).toBe(true);
    expect(recordStorageEvent(f.db, brain, synthetic(kind, STORAGE_EVENT_LIMITS[kind])), `STORAGE_EVENTS_${kind.toUpperCase()}_BOUND`).toBeNull();
    expect(f.events(), "STORAGE_EVENTS_EARLIER_EVIDENCE_KEPT").toEqual(before);
    expect(before.events.filter(event => event.kind === kind)).toHaveLength(STORAGE_EVENT_LIMITS[kind]);
  }
  expect(f.events().paused).toEqual({ pressure: true, refusal: true, scope: true, maintenance: true });
});

test("a full pressure kind pauses the timeline while pressure policy keeps escalating", () => {
  const f = fixture(), brain = f.history.brain;
  for (let index = 0; index < STORAGE_EVENT_LIMITS.pressure - 1; index++) recordStorageEvent(f.db, brain, synthetic("pressure", index));
  f.observe(start, 80_000_000);
  expect(f.events().events.at(-1), "STORAGE_EVENTS_LAST_SLOT_RECORDED").toMatchObject({ kind: "pressure", phase: "start", at: start });
  f.observe(start + 2 * MINUTE, 40_000_000);
  expect(f.history.read()!.metadata.state.pressures[0]!.severity, "STORAGE_EVENTS_PAUSE_KEEPS_POLICY").toBe("critical");
  const response = f.events();
  expect(response.events).toHaveLength(STORAGE_EVENT_LIMITS.pressure);
  expect(response.paused.pressure).toBe(true);
  expect(response.events.some(event => event.at === start + 2 * MINUTE)).toBe(false);
});

test("the worst-case response at every kind's limit stays within the 262,144-byte payload cap", () => {
  const f = fixture(), brain = f.history.brain, max = Number.MAX_SAFE_INTEGER;
  f.db.query("INSERT INTO sqlite_sequence (name, seq) VALUES ('storage_events', ?)").run(max - 4096);
  for (let index = 0; index < STORAGE_EVENT_LIMITS.pressure; index++) recordStorageEvent(f.db, brain, { kind: "pressure", phase: "recovery-started", at: max, identity, severity: "critical", episode: max });
  for (let index = 0; index < STORAGE_EVENT_LIMITS.refusal; index++) recordStorageEvent(f.db, brain, { kind: "refusal", phase: "succeeded", at: max, identity, target: hashScope(index), resource: "unknown" });
  for (let index = 0; index < STORAGE_EVENT_LIMITS.scope; index++) recordStorageEvent(f.db, brain, { kind: "scope", phase: "changed", at: max, identity, rootScope: hashScope(index), previousRootScope: scope });
  for (let index = 0; index < STORAGE_EVENT_LIMITS.maintenance; index++) recordStorageEvent(f.db, brain, { kind: "maintenance", phase: "finished", at: max, receipt: String(index).padStart(96, "o"),
    operation: "cleanup-staging", state: "cancelled", reason: "x".repeat(200), principal: "odysseus" });
  const response = f.events(), bytes = Buffer.byteLength(JSON.stringify(response));
  console.log("STORAGE_EVENTS_WORST_CASE_BYTES", bytes);
  expect(bytes, "STORAGE_EVENTS_WORST_CASE_WITHIN_CAP").toBeLessThanOrEqual(262_144);
  expect(STORAGE_EVENT_LIMITS).toEqual({ pressure: 256, refusal: 128, scope: 64, maintenance: 512, payloadBytes: 262_144 });
  expect(response.events).toHaveLength(256 + 128 + 64 + 512);
  expect(response.events.every(event => String(event.seq).length === 16)).toBe(true);
  expect(response.events.find(event => event.kind === "maintenance")).toMatchObject({ reason: "x".repeat(64) });
});

function maintenanceFixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-event-runs-")), brain = join(root, "brain");
  mkdirSync(join(brain, ".brain", "scratch"), { recursive: true });
  const db = createUiDb(join(root, "ui.sqlite")), storage = createStorageCoordinator({ brainPath: brain, stores: [], authorized: () => true });
  const operations = createStorageMaintenance(db, { brainPath: brain, storage, authorized: () => true,
    boundary: { status: () => ({ hostExecution: "worker", available: true, profile: "strict", protectedPaths: [], identity: "shared_uid", configurationView: "startup" }) },
    brain: { async storagePack() { return { schema_version: 1, action: "pack", state: "complete", packed: 2, reason: null }; } },
    scratch: { async tick() {}, async close() {}, async run() {
      return JSON.stringify({ action: "prune", removed: [], failed: [], bytes: 0, files: 0, pinned: { files: 0, bytes: 0 }, overageBytes: 0 });
    } },
    inbox: { cleanup: undefined } });
  cleanup.push(async () => { await operations.close(); await storage.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, operations, brain: storageBrainKey(brain), key: hashScope(realpathSync(brain)) };
}

test("maintenance runs appear per receipt with their own times, beyond the latest per operation, and pause at the limit", async () => {
  const f = maintenanceFixture();
  expect(f.key).toBe(f.brain);
  const run = async (id: string) => { f.operations.start("odysseus", { id, operation: "prune-scratch" }); await f.operations.idle(); return f.operations.receipt("odysseus", id) as StorageMaintenanceReceipt; };
  const first = await run("odysseus-events-run-0001"), second = await run("odysseus-events-run-0002");
  expect(f.operations.list("odysseus").operations.find(row => row.id === "prune-scratch")!.latest!.id).toBe(second.id);
  const events = readStorageEvents(f.db, f.brain, "odysseus").events;
  expect(events, "STORAGE_EVENTS_MAINTENANCE_PER_RECEIPT").toEqual([
    { seq: expect.any(Number), at: first.requestedAt, kind: "maintenance", receipt: first.id, operation: "prune-scratch", phase: "requested" },
    { seq: expect.any(Number), at: first.completedAt!, kind: "maintenance", receipt: first.id, operation: "prune-scratch", phase: "finished", state: "complete", reason: null },
    { seq: expect.any(Number), at: second.requestedAt, kind: "maintenance", receipt: second.id, operation: "prune-scratch", phase: "requested" },
    { seq: expect.any(Number), at: second.completedAt!, kind: "maintenance", receipt: second.id, operation: "prune-scratch", phase: "finished", state: "complete", reason: null },
  ]);
  expect(readStorageEvents(f.db, f.brain, "penelope").events, "STORAGE_EVENTS_MAINTENANCE_PRINCIPAL_SCOPE").toEqual([]);
  // Reading a receipt again reconciles nothing new and records no second finish.
  f.operations.receipt("odysseus", first.id); f.operations.list("odysseus");
  expect(readStorageEvents(f.db, f.brain, "odysseus").events).toHaveLength(4);
  for (let index = 4; index < STORAGE_EVENT_LIMITS.maintenance - 1; index++) recordStorageEvent(f.db, f.brain, synthetic("maintenance", index));
  const third = await run("odysseus-events-run-0003");
  expect(third.state, "STORAGE_EVENTS_PAUSE_KEEPS_MAINTENANCE").toBe("complete");
  const full = readStorageEvents(f.db, f.brain, "odysseus");
  expect(full.paused.maintenance).toBe(true);
  expect(full.events.filter(event => event.kind === "maintenance" && event.receipt === third.id).map(event => event.phase)).toEqual(["requested"]);
});

test("mounted storage events keep human-owner scope, per-principal receipts, identity filters and since paging", async () => {
  const { generateSignedCookie } = await import("hono/cookie"), { createPrincipal, revokePrincipal } = await import("../src/db/principals");
  const secret = "odysseus-storage-events-secret-0123456789";
  const f = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: secret, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } }); cleanup.push(() => f.close());
  const odysseus = createPrincipal(f.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 }), penelope = createPrincipal(f.app.db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  const athena = createPrincipal(f.app.db, { authMethod: "delegated", createdBy: odysseus.id, label: "Athena", ttlSeconds: 3600 });
  const headers = async (id: string) => ({ cookie: (await generateSignedCookie("brain_ui_session", id, secret)).split(";")[0]! });
  const as = { odysseus: await headers(odysseus.id), penelope: await headers(penelope.id), athena: await headers(athena.id) };
  const read = async (who: Record<string, string>, query = "") => { const response = await f.fetch(`/api/storage/events${query}`, { headers: who }); expect(response.status).toBe(200); return await response.json() as StorageEventsResponse; };
  expect((await f.fetch("/api/storage/events")).status, "STORAGE_EVENTS_ABSENT_CALLER").toBe(401);
  expect((await f.fetch("/api/storage/events", { headers: as.athena })).status, "STORAGE_EVENTS_DELEGATED_FORBIDDEN").toBe(403);
  const empty = await f.fetch("/api/storage/events", { headers: as.odysseus });
  expect(empty.status, "STORAGE_EVENTS_MOUNTED").toBe(200);
  expect(empty.headers.get("cache-control")).toBe("private, no-store");
  expect(await empty.json(), "STORAGE_EVENTS_EMPTY").toEqual({ version: 1, since: 0, next: 0, limits: STORAGE_EVENT_LIMITS, paused: { pressure: false, refusal: false, scope: false, maintenance: false }, events: [] });
  for (const query of ["?limit=5", "?identity=Odysseus", `?identity=${identity.toUpperCase()}`, "?since=-1", "?since=1.5", "?since=99999999999999999"])
    expect((await f.fetch(`/api/storage/events${query}`, { headers: as.odysseus })).status, `STORAGE_EVENTS_INVALID_QUERY ${query}`).toBe(400);

  const run = async (who: Record<string, string>, id: string) => {
    expect((await f.fetch("/api/storage/maintenance", { method: "POST", headers: { ...who, "content-type": "application/json" }, body: JSON.stringify({ id, operation: "cleanup-staging" }) })).status).toBe(202);
    for (let i = 0; i < 150; i++) { const receipt = await (await f.fetch(`/api/storage/maintenance/${id}`, { headers: who })).json() as StorageMaintenanceReceipt; if (!["waiting", "running"].includes(receipt.state)) return receipt; await Bun.sleep(20); }
    throw Error("maintenance did not finish");
  };
  const voyage = await run(as.odysseus, "odysseus-events-voyage-1"), loom = await run(as.penelope, "penelope-events-loom-01"), homecoming = await run(as.odysseus, "odysseus-events-voyage-2");
  const own = (response: StorageEventsResponse) => response.events.map(event => event.kind === "maintenance" && [event.receipt, event.phase, event.at]);
  const mine = await read(as.odysseus);
  expect(own(mine), "STORAGE_EVENTS_PER_PRINCIPAL_RECEIPTS").toEqual([
    [voyage.id, "requested", voyage.requestedAt], [voyage.id, "finished", voyage.completedAt!],
    [homecoming.id, "requested", homecoming.requestedAt], [homecoming.id, "finished", homecoming.completedAt!],
  ]);
  expect(own(await read(as.penelope))).toEqual([[loom.id, "requested", loom.requestedAt], [loom.id, "finished", loom.completedAt!]]);

  const other = hashScope("Ithaca volume"), brain = storageBrainKey(f.brainPath);
  recordStorageEvent(f.app.db, brain, { kind: "pressure", phase: "start", at: start, identity, severity: "low" });
  recordStorageEvent(f.app.db, brain, { kind: "pressure", phase: "start", at: start, identity: other, severity: "critical" });
  const later = await read(as.odysseus, `?since=${mine.next}`);
  expect(later.since).toBe(mine.next);
  expect(later.events.map(event => event.kind === "pressure" && event.identity), "STORAGE_EVENTS_SINCE_PAGING").toEqual([identity, other]);
  const filtered = await read(as.odysseus, `?identity=${identity}`);
  expect(filtered.events.map((event: StorageEvent) => event.kind === "pressure" ? event.identity : event.kind), "STORAGE_EVENTS_IDENTITY_FILTER").toEqual(["maintenance", "maintenance", "maintenance", "maintenance", identity]);
  const caught = await read(as.odysseus, `?since=${later.next}`);
  expect(caught).toMatchObject({ since: later.next, next: later.next, events: [] });
  revokePrincipal(f.app.db, odysseus.id, Date.now());
  expect((await f.fetch("/api/storage/events", { headers: as.odysseus })).status, "STORAGE_EVENTS_REVOKED").toBe(401);
});

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StorageEvent, StorageEventKind, StorageEventsResponse, StorageMaintenanceReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createStorageHistory, storageBrainKey } from "../src/storage/history-store.js";
import { hashScope, type Aggregate } from "../src/storage/history-model.js";
import { newPressure, ownerWrite, type Pressure } from "../src/storage/pressure.js";
import { STORAGE_EVENT_EVIDENCE_LIMIT, STORAGE_EVENT_LIMITS, readStorageEvents, recordStorageEvent } from "../src/storage/events.js";
import { createStorageCoordinator } from "../src/storage/coordinator.js";
import { createStorageMaintenance } from "../src/storage/maintenance.js";
import { httpContractApp } from "./helpers/http-contract-app.js";
import { watchdogMs } from "../../../scripts/test-deadlines.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const start = Date.UTC(2026, 6, 12, 9, 41), MINUTE = 60_000;
const identity = hashScope("Odysseus volume"), scope = hashScope("Odysseus stores");
const TOTAL = 1_000_000_000;
/** `coverage` 2 is a capacity whose measurement is unknown: the observation is retained but is not fresh evidence. */
const aggregate = (at: number, available: number, rootScope = scope, id = identity, coverage: 0 | 2 = 0): Aggregate => ({ at, startedAt: at - 10, source: 1, descriptor: ["0.44.0", scope, 1], coverage: 0, reason: 0,
  capacities: [{ descriptor: [id, rootScope], values: [TOTAL, TOTAL - available, available, available, coverage, 1, 4096, 2, 8192, 0, 0, 3, 12288] }] });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-events-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "operations.sqlite");
  let db = createUiDb(path), now = start;
  cleanup.push(() => db.close());
  let history = createStorageHistory(db, root, { now: () => now });
  return {
    root, get db() { return db; }, get history() { return history; },
    /** Offers an observation made at `at` and flushes it later, as a slow collection would. */
    observe(at: number, available: number, rootScope = scope, coverage: 0 | 2 = 0) { now = at + 5_000; history.offer(aggregate(at, available, rootScope, identity, coverage)); },
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

test("a refusal open before recording began never emits its resolution", () => {
  const f = fixture(); f.observe(start, 500_000_000);
  const report = { identity, rootScope: scope, target: hashScope("Odysseus attachment"), resource: "bytes" as const, outcome: "no-space" as const, at: start + 2 * MINUTE };
  f.advance(report.at); f.history.ownerWrite(report);
  // The refusal and its warning started before this version recorded events.
  f.db.query("DELETE FROM storage_events").run();
  f.advance(report.at + 2 * MINUTE); f.history.ownerWrite({ ...report, at: report.at + 2 * MINUTE, outcome: "success" });
  expect(f.history.read()!.metadata.state.pressures[0]!.refusals[0]!.successAt).toBe(report.at + 2 * MINUTE);
  expect(f.events().events, "STORAGE_EVENTS_NO_ORPHAN_REFUSAL_RESOLUTION").toEqual([]);
  // A refusal that starts afterwards is recorded and resolved as usual.
  f.advance(report.at + 4 * MINUTE); f.history.ownerWrite({ ...report, at: report.at + 4 * MINUTE });
  f.advance(report.at + 6 * MINUTE); f.history.ownerWrite({ ...report, at: report.at + 6 * MINUTE, outcome: "success" });
  expect(f.events().events.filter(event => event.kind === "refusal").map(event => [event.phase, event.at])).toEqual([["refused", report.at + 4 * MINUTE], ["succeeded", report.at + 6 * MINUTE]]);
});

test("a scope first observed after recording began is a starting point, never a change from older state", () => {
  const f = fixture(), b = hashScope("Odysseus stores and the loom"), c = hashScope("Odysseus stores and the bow");
  f.observe(start, 40_000_000);
  // Before this version, the capacity moved to B; that observation was not fresh evidence.
  f.observe(start + 2 * MINUTE, 40_000_000, b, 2);
  f.db.query("DELETE FROM storage_events").run(); f.db.query("DELETE FROM storage_event_scopes").run();
  f.observe(start + 4 * MINUTE, 40_000_000, b, 2);
  expect(f.events().events, "STORAGE_EVENTS_NO_PRE_UPGRADE_SCOPE_CHANGE").toEqual([]);
  f.observe(start + 6 * MINUTE, 40_000_000, c, 2);
  expect(f.events().events.map(event => event.kind === "scope" && [event.previousRootScope, event.rootScope, event.at])).toEqual([[b, c, start + 6 * MINUTE]]);
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

test("buffered repeated refusals keep the first refusal's time for the refusal and the warning it starts", () => {
  const f = fixture(); f.observe(start, 500_000_000);
  const report = { identity, rootScope: scope, target: hashScope("Odysseus attachment"), resource: "bytes" as const, outcome: "no-space" as const, at: start + 10_000 };
  // Both reports arrive inside one write interval and are coalesced before the next flush.
  f.advance(start + 10_000); f.history.ownerWrite(report);
  f.advance(start + 20_000); f.history.ownerWrite({ ...report, at: start + 20_000 });
  expect(f.events().events).toEqual([]);
  f.advance(start + 70_000); expect(f.history.flush()).toBe(true);
  expect(f.history.read()!.metadata.state.pressures[0]!.refusals[0]!.at, "STORAGE_EVENTS_BUFFER_KEEPS_LATEST_SUPPORT").toBe(start + 20_000);
  expect(f.events().events.map(event => [event.kind, event.phase, event.at]), "STORAGE_EVENTS_BUFFERED_REFUSAL_FIRST_TIME").toEqual([
    ["refusal", "refused", start + 10_000], ["pressure", "start", start + 10_000],
  ]);
});

test("buffered refusals across targets start the warning at the earliest refusal of any of them", () => {
  const f = fixture(); f.observe(start, 500_000_000);
  const a = { identity, rootScope: scope, target: hashScope("Odysseus attachment"), resource: "bytes" as const, outcome: "no-space" as const, at: start + 10_000 };
  const b = { ...a, target: hashScope("Penelope attachment"), at: start + 15_000 };
  f.advance(start + 10_000); f.history.ownerWrite(a);
  f.advance(start + 15_000); f.history.ownerWrite(b);
  f.advance(start + 20_000); f.history.ownerWrite({ ...a, at: start + 20_000 });
  f.advance(start + 70_000); expect(f.history.flush()).toBe(true);
  // Pressure state is exactly what it was before the timeline: buffer order puts
  // B before the coalesced A, and the newest refusal supports a Critical notice.
  expect(f.history.read()!.metadata.state.pressures[0], "STORAGE_EVENTS_BUFFER_ORDER_STATE").toMatchObject({ severity: "critical", supportAt: start + 20_000,
    refusals: [{ target: b.target, at: start + 15_000, successAt: null }, { target: a.target, at: start + 20_000, successAt: null }] });
  // The timeline replays the uncoalesced reports in time order instead.
  expect(f.events().events.map(event => [event.kind, event.phase, event.at, event.kind === "refusal" ? event.target : null]), "STORAGE_EVENTS_CROSS_TARGET_START").toEqual([
    ["refusal", "refused", start + 10_000, a.target], ["pressure", "start", start + 10_000, null], ["refusal", "refused", start + 15_000, b.target],
  ]);
});

test("a late refusal report coalesced with newer ones still supplies the first refusal time", () => {
  const f = fixture(); f.observe(start, 500_000_000);
  const report = { identity, rootScope: scope, target: hashScope("Odysseus attachment"), resource: "bytes" as const, outcome: "no-space" as const, at: start + 20_000 };
  f.advance(start + 30_000);
  f.history.ownerWrite(report);
  f.history.ownerWrite({ ...report, at: start + 10_000 });
  f.history.ownerWrite({ ...report, at: start + 30_000 });
  f.advance(start + 70_000); expect(f.history.flush()).toBe(true);
  expect(f.history.read()!.metadata.state.pressures[0]!.refusals).toEqual([{ target: report.target, resource: "bytes", at: start + 30_000, successAt: null }]);
  expect(f.events().events.map(event => [event.kind, event.phase, event.at]), "STORAGE_EVENTS_LATE_REPORT_FIRST_TIME").toEqual([
    ["refusal", "refused", start + 10_000], ["pressure", "start", start + 10_000],
  ]);
});

const s = (seconds: number) => start + seconds * 1000;
type Step = { kind: "observe" } | { kind: "flush"; now: number } | { kind: "write"; target: string; seconds: number; outcome: "no-space" | "success"; now: number; identity: string };
const write = (target: string, seconds: number, outcome: "no-space" | "success" = "no-space", now = seconds, volume = "Odysseus volume"): Step => ({ kind: "write", target, seconds, outcome, now, identity: volume });
const flush = (now: number): Step => ({ kind: "flush", now });
const observed: Step = { kind: "observe" };
/** The same sequences, run once on origin/main before #4541; its pressure state is the fixture. */
const SEQUENCES: Record<string, Step[]> = {
  "cross-target A10 B15 A20": [observed, write("A", 10), write("B", 15), write("A", 20), flush(70)],
  "late A20 A10 A30": [observed, write("A", 20, "no-space", 30), write("A", 10, "no-space", 30), write("A", 30), flush(70)],
  "broken run A10 sA15 A20": [observed, write("A", 10), write("A", 15, "success"), write("A", 20), flush(70)],
  "mixed A10 B15 A20 sB25": [observed, write("A", 10), write("B", 15), write("A", 20), write("B", 25, "success"), flush(70)],
  "stored A then sA B A": [observed, write("A", 10), flush(70), write("A", 75, "success"), write("B", 80), write("A", 85), flush(140)],
  "two capacities": [observed, write("A", 10), write("C", 12, "no-space", 12, "Ithaca volume"), write("A", 20), flush(70)],
  "late success after refusal": [observed, write("A", 10), flush(70), write("A", 90, "no-space", 95), write("A", 80, "success", 95), write("B", 95), flush(140)],
};

test("buffered owner reports leave pressure state byte-identical to the pre-timeline history", async () => {
  const recorded = (await Bun.file(new URL("./fixtures/storage-events-main-pressure.json", import.meta.url)).json()) as { pressures: Record<string, unknown> };
  expect(Object.keys(recorded.pressures).sort()).toEqual(Object.keys(SEQUENCES).sort());
  for (const [name, steps] of Object.entries(SEQUENCES)) {
    const f = fixture();
    for (const step of steps) {
      if (step.kind === "observe") { f.advance(s(5)); f.history.offer(aggregate(start, 500_000_000)); }
      else if (step.kind === "flush") { f.advance(s(step.now)); f.history.flush(); }
      else { f.advance(s(step.now)); f.history.ownerWrite({ identity: hashScope(step.identity), rootScope: scope, target: hashScope(step.target), resource: "bytes", outcome: step.outcome, at: s(step.seconds) }); }
    }
    const pressures = f.history.read()!.metadata.state.pressures.map(value => ({ ...value, episode: value.episode ? "uuid" : null, resolvedEpisode: value.resolvedEpisode ? "uuid" : null }));
    expect(JSON.stringify(pressures), `STORAGE_EVENTS_PRESSURE_MATCHES_MAIN ${name}`).toBe(JSON.stringify(recorded.pressures[name]));
  }
});

test("event-only times never bring the owner-evidence overflow pause forward", () => {
  const f = fixture(); f.observe(start, 500_000_000); f.advance(s(20));
  // 200 coalesced pairs fit the 40,960-byte report budget as before #4541,
  // but would not if the timeline's extra times were charged to it.
  for (let index = 0; index < 200; index++) for (const seconds of [10, 20]) f.history.ownerWrite({ identity, rootScope: scope, target: hashScope(`Ithaca store ${index}`), resource: "bytes", outcome: "no-space", at: s(seconds) });
  expect(f.history.status().paused, "STORAGE_EVENTS_BUDGET_CHARGES_REPORTS_ONLY").toBeNull();
});

test("buffered repeated successes keep the first success's time for the resolution", () => {
  const f = fixture(); f.observe(start, 500_000_000);
  const report = { identity, rootScope: scope, target: hashScope("Odysseus attachment"), resource: "bytes" as const, outcome: "no-space" as const, at: s(10) };
  f.advance(s(10)); f.history.ownerWrite(report); f.advance(s(70)); expect(f.history.flush()).toBe(true);
  f.advance(s(80)); f.history.ownerWrite({ ...report, at: s(80), outcome: "success" });
  f.advance(s(90)); f.history.ownerWrite({ ...report, at: s(90), outcome: "success" });
  f.advance(s(140)); expect(f.history.flush()).toBe(true);
  expect(f.history.read()!.metadata.state.pressures[0]!.refusals[0]!.successAt, "STORAGE_EVENTS_SUCCESS_STATE_UNCHANGED").toBe(s(90));
  expect(f.events().events.filter(event => event.kind === "refusal").map(event => [event.phase, event.at]), "STORAGE_EVENTS_BUFFERED_SUCCESS_FIRST_TIME").toEqual([["refused", s(10)], ["succeeded", s(80)]]);
});

test("a refusal, its resolution and a new refusal buffered for one write are all recorded in time order", () => {
  const f = fixture(); f.observe(start, 500_000_000);
  const report = { identity, rootScope: scope, target: hashScope("Odysseus attachment"), resource: "bytes" as const, outcome: "no-space" as const, at: start + 10_000 };
  f.advance(start + 10_000); f.history.ownerWrite(report);
  f.advance(start + 15_000); f.history.ownerWrite({ ...report, at: start + 15_000, outcome: "success" });
  f.advance(start + 20_000); f.history.ownerWrite({ ...report, at: start + 20_000 });
  f.advance(start + 70_000); expect(f.history.flush()).toBe(true);
  // Coalescing leaves pressure only the last refusal; the timeline keeps all three reports.
  expect(f.events().events.map(event => [event.kind, event.phase, event.at]), "STORAGE_EVENTS_BUFFERED_RUN_RESTARTS").toEqual([
    ["refusal", "refused", start + 10_000], ["pressure", "start", start + 10_000], ["refusal", "succeeded", start + 15_000], ["refusal", "refused", start + 20_000],
  ]);
});

test("scope changes during a warning without fresh capacity evidence chain from the last observed scope", () => {
  const f = fixture(), b = hashScope("Odysseus stores and the loom"), c = hashScope("Odysseus stores and the bow");
  f.observe(start, 40_000_000);
  f.observe(start + 2 * MINUTE, 40_000_000, b, 2);
  f.observe(start + 4 * MINUTE, 40_000_000, c, 2);
  f.observe(start + 6 * MINUTE, 40_000_000, scope, 2);
  expect(f.history.read()!.metadata.state.pressures[0], "STORAGE_EVENTS_UNFRESH_EVIDENCE_KEEPS_FLAG").toMatchObject({ severity: "critical", scopeChanged: false, rootScope: scope });
  expect(f.events().events.flatMap(event => event.kind === "scope" ? [[event.previousRootScope, event.rootScope, event.at]] : []), "STORAGE_EVENTS_SCOPE_CHAIN").toEqual([
    [scope, b, start + 2 * MINUTE], [b, c, start + 4 * MINUTE], [c, scope, start + 6 * MINUTE],
  ]);
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

test("a receipt requested before recording began never emits a finish when it is reconciled", async () => {
  const f = maintenanceFixture();
  f.operations.start("odysseus", { id: "odysseus-pre-upgrade-01", operation: "prune-scratch" }); await f.operations.idle();
  // Make it a receipt left waiting by a process that died before this version recorded events.
  f.db.query("DELETE FROM storage_events").run();
  f.db.query("UPDATE storage_maintenance_operations SET state = 'waiting', pid = ?, pid_start = 'before the timeline' WHERE id = ?").run(process.pid, "odysseus-pre-upgrade-01");
  const reconciled = f.operations.list("odysseus").operations.find(row => row.id === "prune-scratch")!.latest!;
  expect(reconciled, "STORAGE_EVENTS_PRE_UPGRADE_RECEIPT_RECONCILED").toMatchObject({ state: "refused", reason: "interrupted_before_owner" });
  expect(readStorageEvents(f.db, f.brain, "odysseus").events, "STORAGE_EVENTS_NO_ORPHAN_FINISH").toEqual([]);
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

/*
 * Every event time that can come from buffered, coalesced or replayed input (#4541).
 *
 * | Event                                 | Time source                    | How the input can be buffered, coalesced or replayed               | Emitted time                                                     |
 * | ------------------------------------- | ------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
 * | refusal `refused`                     | owner no-space report `at`     | waits for the next history write, where pressure coalesces repeats | replay of every accepted report of the write, uncoalesced, in time |
 * |                                       |                                | per target to the newest; reports can arrive late; one write can   | order: a refusal opens the target's refusal. Over 512 reports in   |
 * |                                       |                                | hold many                                                          | one write pauses the kind instead of guessing                      |
 * | refusal `succeeded`                   | owner success report `at`      | the same buffer                                                    | the same replay: a later success resolves the open refusal         |
 * | pressure `start` / `step` by refusal  | owner no-space report `at`     | the same buffer, across targets of one capacity                    | the same replay: the first refusal on the capacity                 |
 * | pressure `start` / `step` /           | observation `at`               | a pending observation is replaced by a newer one before the write; | the observation pressure policy evaluated. A superseded one is   |
 * | `recovery-started` / `end`            |                                | the replaced one is never evaluated or retained by history         | never evaluated, so no transition exists for it to time. Order   |
 * |                                       |                                |                                                                    | against owner reports in one write is #4560                      |
 * | scope `changed`                       | observation `at`               | the same pending replacement                                       | the evaluated observation that first carried the new scope       |
 * | maintenance `requested`               | receipt `requestedAt`          | not buffered: written in the transaction that admits the receipt   | the receipt's own time                                           |
 * | maintenance `finished`                | receipt `completedAt`          | not buffered; a restart's reconciliation sets `completedAt` when   | the receipt's own time, only after its recorded request          |
 * |                                       |                                | it establishes the interrupted outcome                             |                                                                  |
 *
 * The table-driven test below covers each buffered row with repeats, late
 * arrivals, cross-target and mixed outcomes, within one write and across two;
 * the property test compares random sequences against a one-report-at-a-time
 * oracle. Maintenance times are covered by the per-receipt and reconciliation tests.
 */
type Interleaved = { do: "observe"; at: number; available: number; scope?: string } | { do: "write"; target: string; at: number; outcome?: "success"; now?: number } | { do: "flush"; now: number };
const no = (target: string, at: number, now?: number): Interleaved => ({ do: "write", target, at, ...(now === undefined ? {} : { now }) });
const ok = (target: string, at: number, now?: number): Interleaved => ({ do: "write", target, at, outcome: "success", ...(now === undefined ? {} : { now }) });
const write70 = (now: number): Interleaved => ({ do: "flush", now });
const calm: Interleaved = { do: "observe", at: 0, available: 500_000_000 };
const loom = hashScope("Odysseus stores and the loom");
const INTERLEAVINGS: Array<{ name: string; kinds: StorageEventKind[]; steps: Interleaved[]; expected: Array<[string, string, number, string?]> }> = [
  { name: "refused: repeats in one write", kinds: ["refusal"], steps: [calm, no("A", 10), no("A", 20), write70(70)], expected: [["refusal", "refused", 10, "A"]] },
  { name: "refused: late arrival coalesced", kinds: ["refusal"], steps: [calm, no("A", 20, 30), no("A", 10, 30), no("A", 30), write70(70)], expected: [["refusal", "refused", 10, "A"]] },
  { name: "refused: late arrival not coalesced", kinds: ["refusal"], steps: [calm, no("A", 20, 25), no("A", 10, 25), write70(70)], expected: [["refusal", "refused", 10, "A"]] },
  { name: "refused: cross-target", kinds: ["refusal"], steps: [calm, no("A", 10), no("B", 15), no("A", 20), write70(70)], expected: [["refusal", "refused", 10, "A"], ["refusal", "refused", 15, "B"]] },
  { name: "refused: a resolved pair inside one write is kept", kinds: ["refusal"], steps: [calm, no("A", 10), ok("A", 15), no("A", 20), write70(70)], expected: [["refusal", "refused", 10, "A"], ["refusal", "succeeded", 15, "A"], ["refusal", "refused", 20, "A"]] },
  { name: "refused: an open run continues across writes", kinds: ["refusal"], steps: [calm, no("A", 10), write70(70), no("A", 80), no("A", 90), write70(140)], expected: [["refusal", "refused", 10, "A"]] },
  { name: "refused: reopened after a resolution across writes", kinds: ["refusal"], steps: [calm, no("A", 10), write70(70), ok("A", 80), write70(140), no("A", 150), no("A", 160), write70(210)],
    expected: [["refusal", "refused", 10, "A"], ["refusal", "succeeded", 80, "A"], ["refusal", "refused", 150, "A"]] },
  { name: "succeeded: repeats across writes", kinds: ["refusal"], steps: [calm, no("A", 10), write70(70), ok("A", 80), ok("A", 90), write70(140)], expected: [["refusal", "refused", 10, "A"], ["refusal", "succeeded", 80, "A"]] },
  { name: "succeeded: late arrival", kinds: ["refusal"], steps: [calm, no("A", 10), write70(70), ok("A", 90, 95), ok("A", 80, 95), write70(140)], expected: [["refusal", "refused", 10, "A"], ["refusal", "succeeded", 80, "A"]] },
  { name: "succeeded: cross-target", kinds: ["refusal"], steps: [calm, no("A", 10), no("B", 12), write70(70), ok("B", 80), ok("A", 85), ok("B", 90), write70(140)],
    expected: [["refusal", "refused", 10, "A"], ["refusal", "refused", 12, "B"], ["refusal", "succeeded", 80, "B"], ["refusal", "succeeded", 85, "A"]] },
  { name: "succeeded: mixed outcomes keep every resolution", kinds: ["refusal"], steps: [calm, no("A", 10), write70(70), ok("A", 80), no("A", 85), ok("A", 90), write70(140)],
    expected: [["refusal", "refused", 10, "A"], ["refusal", "succeeded", 80, "A"], ["refusal", "refused", 85, "A"], ["refusal", "succeeded", 90, "A"]] },
  { name: "succeeded: a success before a later refusal resolves the earlier one", kinds: ["refusal"], steps: [calm, no("A", 10), write70(70), ok("A", 80, 95), no("A", 85, 95), ok("A", 95), write70(140)],
    expected: [["refusal", "refused", 10, "A"], ["refusal", "succeeded", 80, "A"], ["refusal", "refused", 85, "A"], ["refusal", "succeeded", 95, "A"]] },
  { name: "succeeded: a late success before the newest refusal resolves the earlier one", kinds: ["refusal"], steps: [calm, no("A", 10), write70(70), no("A", 85, 100), ok("A", 90, 100), ok("A", 82, 100), write70(140)],
    expected: [["refusal", "refused", 10, "A"], ["refusal", "succeeded", 82, "A"], ["refusal", "refused", 85, "A"], ["refusal", "succeeded", 90, "A"]] },
  { name: "succeeded: the first success after each refusal, whatever coalesced", kinds: ["refusal"], steps: [calm, no("A", 10), write70(70), no("A", 85, 100), ok("A", 88, 100), ok("A", 82, 100), ok("A", 95, 100), write70(140)],
    expected: [["refusal", "refused", 10, "A"], ["refusal", "succeeded", 82, "A"], ["refusal", "refused", 85, "A"], ["refusal", "succeeded", 88, "A"]] },
  { name: "refused: a resolution the pressure state reopens is not emitted", kinds: ["refusal"], steps: [calm, no("A", 10), write70(70), ok("A", 80, 100), no("A", 75, 100), no("A", 78, 100), write70(140)],
    expected: [["refusal", "refused", 10, "A"]] },
  { name: "warning start: cross-target coalesced", kinds: ["pressure"], steps: [calm, no("A", 10), no("B", 15), no("A", 20), write70(70)], expected: [["pressure", "start", 10]] },
  { name: "warning step: cross-target coalesced", kinds: ["pressure"], steps: [{ do: "observe", at: 0, available: 80_000_000 }, no("A", 10), no("B", 15), no("A", 20), write70(70)],
    expected: [["pressure", "start", 0], ["pressure", "step", 10]] },
  { name: "warning start: cross-target with a late refusal", kinds: ["pressure"], steps: [calm, no("A", 20, 25), no("B", 12, 25), no("A", 25), write70(70)], expected: [["pressure", "start", 12]] },
  { name: "warning step: low to critical by the earliest refusal", kinds: ["pressure"], steps: [{ do: "observe", at: 0, available: 80_000_000 }, no("A", 20, 25), no("B", 12, 25), no("A", 25), write70(70)],
    expected: [["pressure", "start", 0], ["pressure", "step", 12]] },
  { name: "warning start: not repeated across writes", kinds: ["pressure"], steps: [calm, no("A", 10), write70(70), no("B", 80), no("A", 90), write70(140)], expected: [["pressure", "start", 10]] },
  { name: "observation start: the evaluated observation, not a superseded one", kinds: ["pressure"], steps: [{ do: "observe", at: 70, available: 500_000_000 }, { do: "observe", at: 80, available: 80_000_000 }, { do: "observe", at: 90, available: 80_000_000 }, write70(140)],
    expected: [["pressure", "start", 90]] },
  { name: "scope: the evaluated observation that first carried it", kinds: ["scope"], steps: [{ do: "observe", at: 70, available: 500_000_000 }, { do: "observe", at: 80, available: 500_000_000, scope: loom }, { do: "observe", at: 90, available: 500_000_000, scope: loom }, write70(140), { do: "observe", at: 150, available: 500_000_000, scope: loom }],
    expected: [["scope", "changed", 90]] },
];

// The 22 cases share one migrated database, each with its own brain: measured
// at 1.1 s alone on an idle host, against 23.5 s (48.8 s loaded) with a
// database per case. The watchdog stays far above a loaded run.
test("every buffered event time is its first real evidence across interleaved inputs", () => {
  const began = performance.now();
  const names = new Map(["A", "B"].map(name => [hashScope(name), name]));
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-interleavings-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createUiDb(join(root, "operations.sqlite")); cleanup.push(() => db.close());
  for (const [index, row] of INTERLEAVINGS.entries()) {
    const brain = join(root, `brain-${index}`); mkdirSync(brain);
    let now = start;
    const history = createStorageHistory(db, brain, { now: () => now });
    cleanup.push(() => history.close());
    const f = { history, advance(value: number) { now = value; }, events: () => readStorageEvents(db, history.brain, "odysseus"),
      observe(at: number, available: number, rootScope: string) { now = at + 5_000; history.offer(aggregate(at, available, rootScope)); } };
    for (const step of row.steps) {
      if (step.do === "observe") f.observe(s(step.at), step.available, step.scope ?? scope);
      else if (step.do === "flush") { f.advance(s(step.now)); f.history.flush(); }
      else { f.advance(s(step.now ?? step.at)); f.history.ownerWrite({ identity, rootScope: scope, target: hashScope(step.target), resource: "bytes", outcome: step.outcome ?? "no-space", at: s(step.at) }); }
    }
    expect(f.history.status().paused, `${row.name}: no pause`).toBeNull();
    const events = f.events().events.filter(event => row.kinds.includes(event.kind));
    expect(events.map(event => [event.kind, event.phase, (event.at - start) / 1000, ...(event.kind === "refusal" ? [names.get(event.target)] : [])]), `STORAGE_EVENTS_FIRST_EVIDENCE ${row.name}`).toEqual(row.expected);
  }
  console.log("STORAGE_EVENTS_FIRST_EVIDENCE_MS", Math.round(performance.now() - began));
}, watchdogMs(120_000));

test("a late refusal between buffered successes is resolved by the first success after it", () => {
  const f = fixture(); f.observe(start, 500_000_000);
  const report = { identity, rootScope: scope, target: hashScope("A"), resource: "bytes" as const, outcome: "no-space" as const, at: s(70) };
  f.advance(s(70)); f.history.ownerWrite(report);
  expect(f.history.read()!.metadata.state.pressures[0]!.refusals[0]!.at).toBe(s(70));
  f.advance(s(100));
  for (const [seconds, outcome] of [[80, "success"], [90, "success"], [85, "no-space"], [100, "success"]] as const) f.history.ownerWrite({ ...report, at: s(seconds), outcome });
  f.advance(s(140)); expect(f.history.flush()).toBe(true);
  expect(f.events().events.filter(event => event.kind === "refusal").map(event => [event.phase, (event.at - start) / 1000]), "STORAGE_EVENTS_LATE_REFUSAL_BETWEEN_SUCCESSES").toEqual([
    ["refused", 70], ["succeeded", 80], ["refused", 85], ["succeeded", 90],
  ]);
});

/** A seeded generator, so a failure names a reproducible sequence. */
function random(seed: number) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
type Report = { target: string; outcome: "no-space" | "success"; at: number };
/**
 * The oracle: each committed write's accepted reports, one at a time in time
 * order (arrival order breaking ties), each applied by the pressure policy as if
 * flushed at once, as main applies one report: a report older than the
 * target's committed refusal changes nothing. Events are read off each single
 * step. After each commit the real pressure state, which the differential test
 * holds to main's, has the last word: a resolution it does not hold is dropped.
 */
function oracleCommit(pressure: Pressure, reports: Report[], actual: Pressure, events: Array<[string, string, number, string?]>): Pressure {
  const from = events.length;
  for (const report of reports.map((value, index) => ({ value, index })).sort((a, b) => a.value.at - b.value.at || a.index - b.index).map(item => item.value)) {
    const target = hashScope(report.target), before = pressure.refusals.find(value => value.target === target);
    if (before && before.at > report.at) continue;
    const after = ownerWrite({ ...pressure, at: Math.min(pressure.at, report.at) }, { target, resource: "bytes", at: report.at, outcome: report.outcome }, report.at);
    const now = after.refusals.find(value => value.target === target);
    if (report.outcome === "no-space" && (!before || before.successAt !== null)) events.push(["refusal", "refused", report.at, report.target]);
    if (report.outcome === "success" && before?.successAt === null && now?.successAt === report.at) events.push(["refusal", "succeeded", report.at, report.target]);
    if (pressure.severity !== "critical" && after.severity === "critical") events.push(["pressure", "start", report.at]);
    pressure = after;
  }
  for (const refusal of actual.refusals) {
    if (refusal.successAt !== null || pressure.refusals.find(value => value.target === refusal.target)?.successAt === null) continue;
    const name = ["A", "B", "C"].find(value => hashScope(value) === refusal.target);
    const index = events.findLastIndex((event, position) => position >= from && event[3] === name);
    if (index >= 0 && events[index]![1] === "succeeded") events.splice(index, 1);
  }
  return actual;
}

test("the timeline from buffered writes of one or two writers equals the one-report-at-a-time oracle over 600 random sequences", () => {
  const next = random(4541);
  // One database file for every sequence, two connections for two writers;
  // each sequence gets its own brain, so its own history and timeline.
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-oracle-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "operations.sqlite"), connections = [createUiDb(path), createUiDb(path)];
  cleanup.push(() => { for (const db of connections) db.close(); });
  const coverage = { refused: 0, succeeded: 0, start: 0, late: 0, tied: 0, twoRounds: 0, twoWriters: 0, superseded: 0, persisted: 0 };
  for (let sequence = 0; sequence < 600; sequence++) {
    const brain = join(root, `brain-${sequence}`); mkdirSync(brain);
    const clocks = [s(5), s(5)];
    const writers = connections.map((db, index) => createStorageHistory(db, brain, { now: () => clocks[index]! }));
    const read = () => writers[0]!.read()!.metadata.state;
    const events = () => readStorageEvents(connections[0]!, writers[0]!.brain, "odysseus").events;
    writers[0]!.offer(aggregate(start, 500_000_000));
    const names = ["A", "B", "C"].slice(0, 1 + Math.floor(next() * 3)), count = 1 + Math.floor(next() * 2);
    const expected: Array<[string, string, number, string?]> = [];
    let pressure: Pressure = newPressure(identity, scope);
    const report = (writer: number, value: Report) => writers[writer]!.ownerWrite({ identity, rootScope: scope, target: hashScope(value.target), resource: "bytes", outcome: value.outcome, at: value.at });
    if (next() < 0.5) {
      const persisted: Report = { target: names[0]!, outcome: "no-space", at: s(70) };
      clocks[0] = s(70); report(0, persisted); pressure = oracleCommit(pressure, [persisted], read().pressures[0]!, expected); coverage.persisted++;
    }
    for (let round = 0, rounds = 1 + Math.floor(next() * 2); round < rounds; round++) {
      const base = read().lastPersistedAt, committed = new Set((read().pressures[0]?.refusals ?? []).map(value => value.target));
      const accepted: Report[][] = [];
      for (let writer = 0; writer < count; writer++) {
        const reports: Report[] = Array.from({ length: Math.floor(next() * 7) }, () => ({ target: names[Math.floor(next() * names.length)]!, outcome: next() < 0.55 ? "no-space" as const : "success" as const, at: base + Math.floor(next() * 51) * 1000 }));
        // Late arrivals: deliver in a shuffled order, all inside one write interval.
        for (let index = reports.length - 1; index > 0; index--) { const other = Math.floor(next() * (index + 1)); [reports[index], reports[other]] = [reports[other]!, reports[index]!]; }
        if (reports.some((value, index) => index > 0 && value.at < reports[index - 1]!.at)) coverage.late++;
        if (new Set(reports.map(value => value.at)).size < reports.length) coverage.tied++;
        clocks[writer] = base + 55_000;
        const own = new Set<string>(), kept: Report[] = [];
        for (const value of reports) {
          // As on main, a success is accepted only once its target has a refusal.
          if (value.outcome === "success" && !own.has(value.target) && !committed.has(hashScope(value.target))) continue;
          if (value.outcome === "no-space") own.add(value.target);
          report(writer, value); kept.push(value);
        }
        accepted.push(kept);
      }
      // The writers commit one after the other, in a random order.
      const order = count === 2 && next() < 0.5 ? [1, 0] : [0, 1].slice(0, count);
      for (const [position, writer] of order.entries()) {
        clocks[writer] = base + 120_000 + position * 70_000; writers[writer]!.flush();
        if (accepted[writer]!.length) pressure = oracleCommit(pressure, accepted[writer]!, read().pressures[0]!, expected);
        if (position === 1 && accepted[writer]!.some(value => value.at < base + 120_000 && accepted[order[0]!]!.some(other => other.target === value.target && other.outcome === "no-space" && other.at > value.at))) coverage.superseded++;
      }
      if (round === 1) coverage.twoRounds++;
    }
    if (count === 2) coverage.twoWriters++;
    const timeline = events().filter(event => event.kind === "refusal" || event.kind === "pressure")
      .map(event => [event.kind, event.phase, event.at, ...(event.kind === "refusal" ? [names.find(name => hashScope(name) === event.target)] : [])]);
    expect(timeline, `STORAGE_EVENTS_ORACLE sequence ${sequence}`).toEqual(expected);
    for (const event of timeline) coverage[event[1] as "refused" | "succeeded" | "start"]++;
    for (const writer of writers) writer.close();
  }
  console.log("STORAGE_EVENTS_ORACLE_COVERAGE", JSON.stringify(coverage));
  expect(Math.min(...Object.values(coverage))).toBeGreaterThan(20);
}, watchdogMs(120_000));

test("more owner reports in one write than the evidence cap pause refusal and pressure events instead of guessing", () => {
  const fill = (count: number) => {
    const f = fixture(); f.observe(start, 500_000_000); f.advance(s(55));
    for (let index = 0; index < count; index++) f.history.ownerWrite({ identity, rootScope: scope, target: hashScope("A"), resource: "bytes", outcome: "no-space", at: s(10) + index });
    f.advance(s(120)); expect(f.history.flush()).toBe(true);
    return f;
  };
  const full = fill(STORAGE_EVENT_EVIDENCE_LIMIT);
  expect(full.events().events.map(event => [event.kind, event.phase, event.at]), "STORAGE_EVENTS_EVIDENCE_AT_CAP").toEqual([["refusal", "refused", s(10)], ["pressure", "start", s(10)]]);
  expect(full.events().paused).toEqual({ pressure: false, refusal: false, scope: false, maintenance: false });
  const over = fill(STORAGE_EVENT_EVIDENCE_LIMIT + 1);
  expect(over.history.read()!.metadata.state.pressures[0], "STORAGE_EVENTS_OVERFLOW_KEEPS_STATE").toMatchObject({ severity: "critical", refusals: [{ at: s(10) + STORAGE_EVENT_EVIDENCE_LIMIT }] });
  expect(over.history.status().paused).toBeNull();
  expect(over.events(), "STORAGE_EVENTS_EVIDENCE_OVERFLOW_PAUSES").toMatchObject({ paused: { pressure: true, refusal: true, scope: false, maintenance: false }, events: [] });
  // The cap is per write: two writes of 300 reports each pause nothing.
  const twice = fixture(); twice.observe(start, 500_000_000);
  for (const base of [s(5), s(125)]) {
    twice.advance(base + 50_000);
    for (let index = 0; index < 300; index++) twice.history.ownerWrite({ identity, rootScope: scope, target: hashScope("A"), resource: "bytes", outcome: "no-space", at: base + 10_000 + index });
    twice.advance(base + 120_000); expect(twice.history.flush()).toBe(true);
  }
  expect(twice.events().paused, "STORAGE_EVENTS_EVIDENCE_CAP_PER_WRITE").toEqual({ pressure: false, refusal: false, scope: false, maintenance: false });
  // The pause is durable, and later writes still change pressure without events.
  over.advance(s(130)); over.history.ownerWrite({ identity, rootScope: scope, target: hashScope("B"), resource: "bytes", outcome: "no-space", at: s(130) });
  over.advance(s(200)); over.history.flush(); over.reopen();
  expect(over.events()).toMatchObject({ paused: { pressure: true, refusal: true }, events: [] });
  expect(over.history.read()!.metadata.state.pressures[0]!.refusals).toHaveLength(2);
});

test("a writer's buffered refusal and success never resolve another writer's newer committed refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-writers-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "operations.sqlite"), first = createUiDb(path), second = createUiDb(path);
  cleanup.push(() => { first.close(); second.close(); });
  let clockA = s(5), clockB = s(5);
  const a = createStorageHistory(first, root, { now: () => clockA }), b = createStorageHistory(second, root, { now: () => clockB });
  a.offer(aggregate(start, 500_000_000));
  const report = { identity, rootScope: scope, target: hashScope("A"), resource: "bytes" as const, outcome: "no-space" as const };
  clockA = s(15); a.ownerWrite({ ...report, at: s(10) }); a.ownerWrite({ ...report, at: s(15), outcome: "success" });
  clockB = s(70); b.ownerWrite({ ...report, at: s(20) });
  expect(b.read()!.metadata.state.pressures[0]!.refusals).toEqual([{ target: report.target, resource: "bytes", at: s(20), successAt: null }]);
  clockA = s(140); expect(a.flush()).toBe(true);
  expect(a.read()!.metadata.state.pressures[0]!.refusals, "STORAGE_EVENTS_WRITERS_STATE_OPEN").toEqual([{ target: report.target, resource: "bytes", at: s(20), successAt: null }]);
  expect(readStorageEvents(first, a.brain, "odysseus").events.map(event => [event.kind, event.phase, (event.at - start) / 1000]), "STORAGE_EVENTS_WRITERS_NO_FALSE_RESOLUTION").toEqual([
    ["refusal", "refused", 20], ["pressure", "start", 20],
  ]);
  a.close(); b.close();
});

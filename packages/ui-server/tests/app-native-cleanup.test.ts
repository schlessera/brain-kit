import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import * as database from "../src/db/client.js";
import { createNativeBrainLeaseManager } from "../src/brain/native-brain-leases.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "./helpers/fixture-native-startup.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-app-native-cleanup-")), brain = join(root, "brain"), state = join(root, "state"); mkdirSync(brain); mkdirSync(state);
  const native = createNativeJournalFixture(brain, state), broker = native.serve(), restore = replaceNativeStartupAcquisitionForFixture();
  const leasePath = join(state, "native-leases.sqlite");
  const config = { ...resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", BRAIN_PATH: brain, DB_PATH: join(state, "ui.sqlite"), BRAIN_UI_PRICING_DISCOVERY: "0" }),
    nativeBrain: { socketPath: broker.socketPath, leasePath, timeoutMs: 30000, maxDeltaBytes: 64 * 1024 ** 2 } };
  const registry = createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]);
  return { native, config, registry, leasePath, async close() { broker.close(); await native.close(); restore(); rmSync(root, { recursive: true, force: true }); } };
}

test("app shutdown closes operational state even after journal cleanup rejects, preserving its original error", async () => {
  const f = fixture(), app = await createApp({ config: f.config, registry: f.registry, observability: createRecordingObservability() });
  const journal = app.wsHost.journal!, close = journal.close.bind(journal), failure = Error("Fixture journal cleanup failed after settling roots");
  journal.close = async () => { await close(); throw failure; };
  try {
    await expect(app.close()).rejects.toBe(failure);
    expect(() => app.db.query("SELECT 1").get(), "APP_CLEANUP_FAILURE_STILL_CLOSES_UI_DATABASE").toThrow();
    expect(app.wsHost.closing).toBe(true);
    await expect(app.close()).rejects.toBe(failure);
  } finally { await f.close(); }
});

test("unknown native deletion stays durable while app shutdown still closes UI state and can be reconciled", async () => {
  const f = fixture(), app = await createApp({ config: f.config, registry: f.registry, observability: createRecordingObservability() });
  const release = f.native.client.release;
  let ledger: Database | undefined;
  try {
    await app.wsHost.journal!.begin("cleanup-turn", { actor: "interactive", sessionId: "ithaca", model: null, profile: "governed", policyHash: "fixture" }, () => {});
    f.native.client.release = async () => { throw Error("Fixture unknown native deletion receipt"); };
    await expect(app.close()).rejects.toBeInstanceOf(AggregateError);
    expect(() => app.db.query("SELECT 1").get(), "APP_UNKNOWN_NATIVE_RELEASE_STILL_CLOSES_UI_DATABASE").toThrow();
    ledger = new Database(f.leasePath);
    const rows = ledger.query("SELECT id,state FROM native_root_leases").all() as { id: string; state: string }[];
    expect(rows.length, "APP_UNKNOWN_RELEASE_RETAINS_DURABLE_OWNERSHIP").toBeGreaterThan(0);
    expect(rows.every(row => row.state === "deleting")).toBe(true);
    f.native.client.release = release;
    const ready = await f.native.client.ready(), recovery = await createNativeBrainLeaseManager(f.native.client, { statePath: f.leasePath, brainPath: ready.brainPath, fsid: ready.fsid, brainUuid: ready.brainUuid });
    try {
      expect((await recovery.recoverDeadOwners()).released.sort()).toEqual(rows.map(row => row.id).sort());
      expect(ledger.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
    } finally { await recovery.close(); }
  } finally { f.native.client.release = release; ledger?.close(); await f.close(); }
});

test("late app boot failure drains acquired runtimes and closes its UI database handle", async () => {
  const f = fixture(), handles: ReturnType<typeof database.createUiDb>[] = [], original = database.createUiDb;
  const capture = spyOn(database, "createUiDb").mockImplementation((...args) => { const db = original(...args); handles.push(db); return db; });
  const observability = createRecordingObservability(), meter = observability.meter.bind(observability), failure = Error("Fixture late boot auth meter refusal");
  observability.meter = name => { if (name === "auth") throw failure; return meter(name); };
  try {
    await expect(createApp({ config: f.config, registry: f.registry, observability })).rejects.toBe(failure);
    expect(handles.length, "APP_LATE_BOOT_FAILURE_EXERCISES_OPEN_UI_STATE").toBeGreaterThan(0);
    for (const db of handles) expect(() => db.query("SELECT 1").get(), "APP_LATE_BOOT_FAILURE_CLOSES_EVERY_UI_HANDLE").toThrow();
  } finally { capture.mockRestore(); await f.close(); }
});

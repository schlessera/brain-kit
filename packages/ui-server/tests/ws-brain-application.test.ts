import { createFixtureHostBoundary } from "./helpers/native-host-fixture.js";
import { boundaryPlanner, inProcessPlanner, type ApplicationPlanner } from "../src/brain/application.js";
import { createIndexBatch, IndexFlushError } from "../src/brain/index-batch.js";
import { createBrainAccess } from "../../ui-backend-pi/src/brain-access.js";
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKeyedLock, type BackendBridge, type BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityStream } from "../src/activity/stream.js";
import { createTurnRecorder } from "../src/activity/recorder.js";
import { createUiDb } from "../src/db/client.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { runSession } from "../src/ws/run-session.js";
import { WsHost } from "../src/ws/host.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

test("the real session bridge applies, rechecks revocation and records exact effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-brain-application-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "application-test" });
  const stream = createActivityStream(store);
  let currentAuthority = true; let bridge: BackendBridge | undefined;
  const results: BrainApplicationResult[] = [];
  const backend = makeFakeBackend({ id: "pi", startTurn: async req => {
    bridge = req.bridge;
    expect(req.bridge.applyBrain).toBeDefined();
    results.push(await req.bridge.applyBrain!({ operation: "write", path: "notes/ws-raft.md", content: "Odysseus rows.\n", expectedBaseHash: null }));
    currentAuthority = false;
    results.push(await req.bridge.applyBrain!({ operation: "write", path: "notes/refused-raft.md", content: "Untrusted raft", expectedBaseHash: null }));
  } });
  backend.brainApplicationPolicy = () => ({ autoAllowed: ["write"], available: ["write"], lock: createKeyedLock() });
  const host = new WsHost({ brainPath: root, applicationPlanner: boundaryPlanner(createFixtureHostBoundary({ brainPath: root })), registry: createStaticBackendRegistry([backend], "pi"), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: () => currentAuthority, activity: { store, stream } });
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  try {
    const running = runSession(host, { authorization, text: "Repair the raft", attachments: [] });
    authorization.release(); await running;
    expect(results).toHaveLength(2); expect(results[0]!.ok).toBe(true); expect(results[1]!.code).toBe("authority_revoked");
    expect(existsSync(join(root, "notes/refused-raft.md")), "REFUSED_APPLICATION_HAS_NO_EFFECT_AFTER_IDLE").toBe(false);
    expect(readFileSync(join(root, "notes/ws-raft.md"), "utf8")).toBe("Odysseus rows.\n");
    const events = db.query("SELECT event_type, payload AS payload_json FROM activity_events WHERE event_type LIKE 'brain_application%'").all() as { event_type: string; payload_json: string }[];
    expect(events.filter(e => e.event_type === "brain_application_change")).toHaveLength(1);
    expect(events.filter(e => e.event_type === "brain_application")).toHaveLength(2);
    const payloads = events.map(e => JSON.parse(e.payload_json).v);
    expect(payloads).toContainEqual(expect.objectContaining({ path: "notes/ws-raft.md", contentHash: results[0]!.changes[0]!.contentHash }));
    expect(payloads).toContainEqual(expect.objectContaining({ ok: false, code: "authority_revoked", changeCount: 0 }));
    currentAuthority = true;
    expect((await bridge!.applyBrain!({ operation: "write", path: "notes/late-raft.md", content: "Late raft", expectedBaseHash: null })).ok).toBe(false);
  } finally { host.close(); stream.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("history retains every maximum-length named effect without event truncation", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db, { writer: "application-history" });
    const recorder = createTurnRecorder({ store }, { turnId: "raft-turn", sessionId: "raft-session", principalId: "odysseus" });
    const changes = Array.from({ length: 32 }, (_, n) => ({ path: `notes/${"r".repeat(1000)}-${n}.md`, contentHash: "a".repeat(64) }));
    recorder.recordApplication!({ ok: true, message: "Applied Markdown", changes });
    const snapshot = store.snapshotRun(recorder.runId)!;
    const effects = snapshot.events.filter(e => e.eventType === "brain_application_change");
    expect(effects).toHaveLength(32);
    expect(effects.every(e => !e.truncated)).toBe(true);
    expect(effects.map(e => { const c = e.payload as { path: string; contentHash: string }; return { path: c.path, contentHash: c.contentHash }; })).toEqual(changes);
  } finally { db.close(); }
});

// #2835: the real session bridge waits index readers for queued application
// updates, and the end of the turn flushes what is still queued, before its
// Activity terminal, with each outcome appended after the application it follows.
async function deferredSession(options: { failIndex?: () => string | undefined; shared?: boolean; turn: (bridge: BackendBridge, index: { runs: string[][] }, search: (query: string) => Promise<string[]>) => Promise<void> }) {
  const root = mkdtempSync(join(tmpdir(), "ws-brain-index-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  await inProcessPlanner.index(root, undefined);
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "application-index-test" });
  const stream = createActivityStream(store);
  const index = { runs: [] as string[][] };
  const real = boundaryPlanner(createFixtureHostBoundary({ brainPath: root }));
  const planner: ApplicationPlanner = { planAdd: real.planAdd, async index(target, signal, paths) {
    index.runs.push([...(paths ?? [])]);
    const failure = options.failIndex?.();
    if (failure) throw new Error(failure);
    return real.index(target, signal, paths);
  } };
  const indexBatch = options.shared ? createIndexBatch({ index: paths => planner.index(root, undefined, paths) }) : undefined;
  const search = async (query: string) => (await createBrainAccess(root).search({ query, limit: 50 })).results.map(result => result.path).sort();
  const backend = makeFakeBackend({ id: "pi", startTurn: async req => { await options.turn(req.bridge, index, search); } });
  backend.brainApplicationPolicy = () => ({ autoAllowed: ["write"], available: ["write"], lock: createKeyedLock() });
  const host = new WsHost({ brainPath: root, applicationPlanner: planner, ...(indexBatch ? { indexBatch } : {}), registry: createStaticBackendRegistry([backend], "pi"), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: () => true, activity: { store, stream } });
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  const running = runSession(host, { authorization, text: "Land on Scheria", attachments: [] });
  authorization.release(); await running;
  const events = (db.query("SELECT event_type, payload AS payload_json FROM activity_events WHERE event_type LIKE 'brain_application%' ORDER BY rowid").all() as { event_type: string; payload_json: string }[])
    .map(e => ({ type: e.event_type, ...JSON.parse(e.payload_json).v }));
  return { root, events, search, host, index, close: () => { host.close(); stream.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const scheria = (path: string, word: string) => ({ operation: "write" as const, path, content: `---\ntitle: ${path}\ntype: note\n---\nOdysseus meets ${word}.\n`, expectedBaseHash: null });

test("the real session bridge waits index readers and flushes the rest at turn end (#2835)", async () => {
  const seen: Record<string, string[]> = {};
  const session = await deferredSession({ turn: async (bridge, index, search) => {
    const first = await bridge.applyBrain!(scheria("notes/scheria-shore.md", "Nausicaa"));
    expect(first).toMatchObject({ ok: true, indexed: false, indexStatus: "pending" });
    await bridge.awaitIndex!("read_file");
    expect(index.runs).toEqual([]);
    await bridge.awaitIndex!("brain_search");
    expect(index.runs).toEqual([["notes/scheria-shore.md"]]);
    seen.inTurn = await search("Nausicaa");
    expect((await bridge.applyBrain!(scheria("notes/scheria-palace.md", "Arete"))).ok).toBe(true);
  } });
  try {
    expect(seen.inTurn).toEqual(["notes/scheria-shore.md"]);
    // Only the turn's end could have indexed the second write.
    expect(session.index.runs).toEqual([["notes/scheria-shore.md"], ["notes/scheria-palace.md"]]);
    expect(await session.search("Arete")).toEqual(["notes/scheria-palace.md"]);
    const applications = session.events.filter(e => e.type === "brain_application");
    const indexes = session.events.filter(e => e.type === "brain_application_index");
    expect(applications.map(e => [e.indexed, e.indexStatus])).toEqual([[false, "pending"], [false, "pending"]]);
    expect(indexes.map(e => [e.applicationId, e.indexed])).toEqual(applications.map(e => [e.applicationId, true]));
    expect(indexes.every(e => !("indexError" in e))).toBe(true);
    // Each outcome lands after its application. The recorder drops anything
    // after the run's terminal, so the second outcome proves the flush came first.
    const order = session.events.map(e => e.type);
    expect(order.lastIndexOf("brain_application_index")).toBeGreaterThan(order.lastIndexOf("brain_application"));
  } finally { session.close(); }
});

test("a failed index update refuses the reader, is on the Activity record, and stays queued past turn end (#2835)", async () => {
  let failure: string | undefined = "maintenance worker timed out";
  const refusals: string[] = [];
  const session = await deferredSession({ shared: true, failIndex: () => failure, turn: async bridge => {
    expect((await bridge.applyBrain!(scheria("notes/scheria-games.md", "Laodamas"))).ok).toBe(true);
    await bridge.awaitIndex!("brain_search").catch((error: Error) => { refusals.push(error.message); });
  } });
  try {
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("notes/scheria-games.md");
    expect(refusals[0]).toContain("maintenance worker timed out");
    expect(readFileSync(join(session.root, "notes/scheria-games.md"), "utf8")).toContain("Laodamas");
    // The read barrier and the turn's end each tried the update.
    expect(session.index.runs).toHaveLength(2);
    const indexes = session.events.filter(e => e.type === "brain_application_index");
    expect(indexes).toEqual([expect.objectContaining({ indexed: false, indexError: "maintenance worker timed out" })]);
    expect(session.host.indexBatch!.pending()).toBe(true);
    await expect(session.host.indexBatch!.barrier()).rejects.toBeInstanceOf(IndexFlushError);
    failure = undefined;
    await session.host.indexBatch!.barrier();
    expect(await session.search("Laodamas")).toEqual(["notes/scheria-games.md"]);
  } finally { session.close(); }
});

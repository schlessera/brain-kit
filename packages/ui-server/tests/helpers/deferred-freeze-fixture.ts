import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { request } from "node:http";
import { openSqliteWriter } from "../../src/db/write-worker";
import { journalDatabasePath } from "../../src/db/journal-database";
import { createUiDb } from "../../src/db/client";
import { createTurnJournal } from "../../src/brain/turn-journal";
import { createTurnScope } from "../../src/brain/turn-scope";
import { prepareTurnEgress } from "../../src/brain/turn-egress";
import { registeredInterval } from "./registered-interval";
import { createNativeJournalFixture } from "./native-journal-fixture";

export const body = (id = "loom") => JSON.stringify({ model: "odysseus", stream: true, tools: [{ name: "Write" }], messages: [
  { role: "assistant", content: [{ type: "tool_use", id, name: "Write", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Ithaca" }] },
] });
export async function fixture(cap = 100, realWorker?: Parameters<ReturnType<typeof createTurnScope>["workerStarted"]>[1], offloopScope = false) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-deferred-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(brain); writeFileSync(join(brain, "note.md"), "Odysseus");
  const native = createNativeJournalFixture(brain, root), db = createUiDb(path), controller = new AbortController();
  const writer = offloopScope ? openSqliteWriter(db, { attach: [{ schema: "journal", path: journalDatabasePath(path) }] }) : undefined;
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), ...(writer ? { writer } : {}) });
  let beforeScope = () => {};
  journal.onObservation(() => beforeScope());
  const scope = createTurnScope(db, { brainPath: brain, journal, ...(writer ? { writer } : {}), connected: () => true, changed() {}, space: () => ({ total: 100e9, free: 90e9 }) });
  db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',0,0)").run();
  const policy = resolveGovernancePolicy({ schema_version: 1, scope: { max_files_changed: cap } });
  const interval = registeredInterval();
  await journal.begin("voyage", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => controller.abort(error));
  interval.finishRegistration();
  await scope.begin("voyage", { sessionId: "ithaca", principalId: "captain", origin: "interactive", profile: "governed", policy, source: "policy", hardTimeoutMs: 1e6, current: () => !controller.signal.aborted, stop: reason => controller.abort(new Error(reason)) });
  let frozen = false, stops = 0, resumes = 0, ack: boolean | void = true;
  const worker = { freeze() { frozen = true; stops++; return ack; }, resume() { frozen = false; resumes++; return true; }, kill() { frozen = true; return true; }, exited: new Promise<number>(() => {}) };
  scope.workerStarted("voyage", realWorker ?? worker);
  const proxy = await prepareTurnEgress({ policy, controller, turnId: "voyage", sessionId: () => "ithaca", model: () => null,
    profile: "governed", origin: "interactive", journal, scope,
    bridge: { emit() {}, requestPermission: async () => ({ behavior: "deny" }) } as unknown as BackendBridge });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!;
  const realSet = setTimeout, realClear = clearTimeout;
  const deadlines: { callback: () => void; handle: ReturnType<typeof setTimeout>; cancelled: boolean }[] = [];
  Object.defineProperty(globalThis, "setTimeout", { ...descriptor, value: (callback: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 50) return realSet(callback, ms, ...args);
    const handle = { unref() {} } as ReturnType<typeof setTimeout>;
    deadlines.push({ callback, handle, cancelled: false }); return handle;
  } });
  Object.defineProperty(globalThis, "clearTimeout", { ...clearDescriptor, value: (handle: ReturnType<typeof setTimeout>) => {
    const item = deadlines.find(item => item.handle === handle);
    if (item) item.cancelled = true; else realClear(handle);
  } });
  const restore = () => { interval.restore(); Object.defineProperty(globalThis, "setTimeout", descriptor); Object.defineProperty(globalThis, "clearTimeout", clearDescriptor); };
  const result = (id = "loom") => { journal.toolStarted("voyage", id, "Write", true); return journal.toolEnded("voyage", id); };
  return { writer, beforeScope(fn: () => void) { beforeScope = fn; }, tick() { interval.advanceTo(15000); }, deadlines, fireDeadline() { const item = deadlines.find(item => !item.cancelled)!; item.cancelled = true; item.callback(); }, root, brain, db, native, journal, scope, proxy, controller, result, get frozen() { return frozen; }, get stops() { return stops; }, get resumes() { return resumes; }, ack(value: boolean | void) { ack = value; },
    async close() { try { controller.abort(); proxy.stop(); await proxy.settled(); await journal.idle(); scope.close(); await journal.close(); await writer?.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } finally { restore(); } } };
}
export function send(socketPath: string, content = body(), path = "/v1/messages") {
  return new Promise<{ status: number; bytes: number }>((resolve, reject) => {
    const outgoing = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json" } }, incoming => {
      let bytes = 0; incoming.on("data", chunk => { bytes += chunk.length; }); incoming.on("end", () => resolve({ status: incoming.statusCode!, bytes })); incoming.on("error", reject);
    }); outgoing.on("error", reject); outgoing.end(content);
  });
}

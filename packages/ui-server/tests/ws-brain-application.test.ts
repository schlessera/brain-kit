import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], "pi"), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: () => currentAuthority, activity: { store, stream } });
  const authorization = host.coordinator.openAuthorization({ principalId: "odysseus", valid: true, expiresAt: Number.MAX_SAFE_INTEGER });
  try {
    const running = runSession(host, { authorization, text: "Repair the raft", attachments: [] });
    authorization.release(); await running;
    expect(results).toHaveLength(2); expect(results[0]!.ok).toBe(true); expect(results[1]!.code).toBe("authority_revoked");
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

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { safetyCatalogCreated, safetyRecords } from "../src/governance/safety-store";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { prepareRelayedEgress } from "../src/ws/session-run/backend-entry";
import type { TurnBudget } from "../src/ws/session-run/budget";
import type { TurnRun } from "../src/ws/session-run/types";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-safety-boundaries-"));
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
  const writes = createGovernanceWrites(db, writer);
  return { root, db, writer, writes, async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

function providerRequest(socketPath: string, origin: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "odysseus", messages: [] });
    const request = httpRequest({ socketPath, path: "/v1/messages", method: "POST", headers: {
      "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
      "x-brain-provider": "anthropic", "x-brain-provider-key": "ODYSSEUS_RELAY_KEY", "x-brain-provider-origin": origin,
    } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

for (const mode of ["healthy", "own-turn-recording-loss", "other-chat-recording-loss", "cancelled"] as const) {
  test(`final provider admission rechecks ${mode} after the budget wait`, async () => {
    const f = fixture(), controller = new AbortController();
    let requests = 0, admissions = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({ content: [] }); } });
    const waiting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const saved = Object.getOwnPropertyDescriptor(process.env, "ODYSSEUS_RELAY_KEY");
    process.env.ODYSSEUS_RELAY_KEY = "odysseus-offline-only-key";
    const run = {
      host: { activity: { governanceDb: f.db, governanceWrites: f.writes },
        cliProviderOrigins: new Map([["ODYSSEUS_RELAY_KEY", [upstream.url.origin]]]),
        budgets: { async providerAdmission() {
          // The relay calls admission before upload and again immediately before fetch.
          if (++admissions === 2) { waiting.resolve(); await release.promise; }
          return undefined;
        }, async observeProvider() { return null; } } },
      turn: { turnId: "requesting-turn", sessionId: null }, backend: makeFakeBackend({ id: "claude" }),
      abortController: controller, stops: {}, origin: "interactive", mainModel: null,
      held: { governedHold: { sandbox: { profile: "governed" }, policy: { hash: "a".repeat(64), policy: resolveGovernancePolicy({ schema_version: 1 }) } } },
    } as unknown as TurnRun;
    const budget = { write(pending: Promise<unknown>) { void pending; } } as TurnBudget;
    try {
      for (const turnId of ["requesting-turn", "other-turn"]) {
        await f.writes.safetyBegin({ turnId, bindingId: crypto.randomUUID(), sessionId: null, principalId: "odysseus", backendId: "claude", at: 0 });
        await f.writes.safetyReady(turnId, "claude", 1);
      }
      await prepareRelayedEgress(run, { emit() {}, requestPermission: async () => ({ behavior: "allow" }) }, budget);
      const response = providerRequest(run.held.providerRelay!.socketPath, upstream.url.origin);
      await waiting.promise;
      if (mode === "own-turn-recording-loss") {
        // The loss notice lands during the wait, leaving this turn's signal live.
        await f.writes.safetyFail("requesting-turn");
        expect(controller.signal.aborted, "SAFETY_LOSS_LEAVES_REQUEST_SIGNAL_LIVE").toBe(false);
        expect(f.writes.recordingAvailable("requesting-turn", null)).toBe(false);
      } else if (mode === "other-chat-recording-loss") {
        // Another chat's loss restricts that chat, not this request (#3812).
        await f.writes.safetyFail("other-turn");
        expect(f.writes.recordingAvailable("requesting-turn", null), "SAFETY_OTHER_CHAT_LOSS_LEAVES_THIS_TURN").toBe(true);
      } else if (mode === "cancelled") controller.abort();
      release.resolve();
      const result = await response;
      expect(admissions, "SAFETY_TEST_REACHES_FINAL_BUDGET_WAIT").toBe(2);
      const passes = mode === "healthy" || mode === "other-chat-recording-loss";
      expect(requests, "SAFETY_LOSS_DURING_FINAL_WAIT_NEVER_REACHES_UPSTREAM").toBe(passes ? 1 : 0);
      expect(result.status).toBe(passes ? 200 : 403);
      if (!passes) expect(result.body).toContain("Input recording is unavailable");
    } finally {
      release.resolve();
      await run.held.providerRelay?.stop();
      run.held.turnEgress?.stop();
      await run.held.turnEgress?.settled();
      upstream.stop(true);
      if (saved) Object.defineProperty(process.env, "ODYSSEUS_RELAY_KEY", saved); else delete process.env.ODYSSEUS_RELAY_KEY;
      await f.close();
    }
  });
}

test("queued handoff turns retain the original inherited evidence without copying later source activity", async () => {
  const f = fixture();
  const principal = createPrincipal(f.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 60 });
  const authorization = testAuthorization(principal.id);
  const bindingId = crypto.randomUUID();
  const records = (sessionId: string) => safetyRecords(f.db, sessionId).filter(record => record.kind === "occurrence");
  let turns = 0;
  const inherited: number[] = [];
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    await request.bridge.inputSafety!.ready("claude", 1);
    request.bridge.emit({ type: "session_info", sessionId: "destination", isNew: !request.sessionId });
    await f.writes.bind(request.turnId!, "destination");
    inherited.push(records("destination").length);
    if (++turns === 1) {
      await source.begin("later-source", "WebFetch", { url: "https://troy.invalid/later" });
      await source.result("later-source", "WebFetch", "A later source notice.", true);
      const turn = [...host.coordinator.running][0]!;
      for (const text of ["Continue the voyage.", "Return to Ithaca."]) turn.queue.push({
        principalId: principal.id, authorization, text, attachments: [], releaseAuthorization() {},
      });
    }
    request.bridge.emit({ type: "result", sessionId: "destination", durationMs: 1, numTurns: 1, isError: false });
  } });
  const store = createActivityStore(f.db), stream = createActivityStream(store);
  const host = new WsHost({ brainPath: f.root, registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => f.db), activity: { store, stream, governanceDb: f.db, governanceWrites: f.writes } });
  const source = createSafetyCollector(f.db, f.writes, { turnId: "source-turn", bindingId, backendId: "claude", sessionId: () => "source",
    signal: new AbortController().signal, shellProxied: () => true, brainPath: f.root });
  const errors: unknown[] = [];
  host.clients.add({ send(data) { const frame = JSON.parse(data); if (frame.type === "error") errors.push(frame); } }, principal.id);
  try {
    await f.writes.safetyBegin({ turnId: "source-turn", bindingId, sessionId: null, principalId: principal.id, backendId: "claude", at: 0 });
    f.db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('source',0,0,'claude')").run();
    f.db.query("INSERT INTO chat_session_owners VALUES('source',?,0)").run(principal.id);
    safetyCatalogCreated(f.db, "source", principal.id, "source-turn");
    await f.writes.bind("source-turn", "source");
    await source.ready("claude", 1);
    await source.begin("original-source", "WebFetch", { url: "https://ithaca.invalid/original" });
    await source.result("original-source", "WebFetch", "The original harbour notice.", true);
    await runSession(host, { authorization, text: "Hand off the voyage.", attachments: [],
      handoffHooks: { sourceSessionId: "source", onNamed() {}, onSettled() {} } });
    expect(errors, "SAFETY_QUEUED_HANDOFF_REACHES_BACKEND").toEqual([]);
    expect(turns).toBe(3);
    expect(records("source")).toHaveLength(2);
    expect(inherited, "SAFETY_HANDOFF_INHERITS_ONCE_AND_EXCLUDES_LATER_SOURCE_ACTIVITY").toEqual([1, 1, 1]);
    expect(f.writes.safety(null, "destination").unresolvedCount).toBe(1);
    expect(f.writes.safety(null, "destination").coverage.state).toBe("incomplete");
  } finally { host.close(); await f.close(); }
});

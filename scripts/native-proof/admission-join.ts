/** Offline measurement of both inference fences with real FULL audit writes. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { startInferenceRelay, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { openSqliteWriter } from "../../packages/ui-server/src/db/write-worker.js";
import { createGovernanceWrites } from "../../packages/ui-server/src/governance/event-writes.js";
import { prepareTurnEgress } from "../../packages/ui-server/src/brain/turn-egress.js";
import { request } from "node:http";
import { createTurnJournal, type TurnJournal } from "../../packages/ui-server/src/brain/turn-journal.js";
import { createTurnScope, type TurnScope } from "../../packages/ui-server/src/brain/turn-scope.js";
import { journalInference } from "../../packages/ui-server/src/brain/journal-inference.js";
import { journalDatabasePath } from "../../packages/ui-server/src/db/journal-database.js";
import { createNativeJournalFixture } from "../../packages/ui-server/tests/helpers/native-journal-fixture.js";
import type { Database } from "bun:sqlite";
import type { GovernanceWrites } from "../../packages/ui-server/src/governance/event-writes.js";

export async function measureAdmissionJoin(directory: string, samples = 5, host?: { journal: TurnJournal; scope: TurnScope; db: Database; writes: GovernanceWrites }) {
  const root = mkdtempSync(join(directory, "admission-join-")), path = join(root, "ui.db"), brain = join(root, "brain");
  mkdirSync(brain); writeFileSync(join(brain, "note.md"), "Odysseus returns to Ithaca.");
  const db = host?.db ?? createUiDb(path);
  const writer = host ? undefined : openSqliteWriter(db, { attach: [{ schema: "journal", path: journalDatabasePath(path) }] });
  const writes = host?.writes ?? createGovernanceWrites(db, writer);
  const native = host ? undefined : createNativeJournalFixture(brain, root);
  const journal = host?.journal ?? createTurnJournal(db, { brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), nativeManager: native!.manager, writer });
  const scope = host?.scope ?? createTurnScope(db, { brainPath: brain, journal, writer, governance: writes, connected: () => true, changed() {}, space: () => ({ total: 100e9, free: 90e9 }) });
  const policy = resolveGovernancePolicy({ schema_version: 1 });
  const rows: { hold: "drained" | "removed"; delayMs: number; sample: number; queuedCommits: number; admitMs: number; credentialToDispatchMs: number; fences: number; admissionFencesMs: number[]; requestAfterResultMs: number; dispatchAfterResultMs: number }[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { await req.arrayBuffer(); return new Response("Ithaca"); } });
  try {
    for (const hold of ["drained", "removed"] as const) for (const delayMs of [10, 50, 500]) for (let sample = 0; sample < samples; sample++) {
      const turnId = `voyage-${hold}-${delayMs}-${sample}`;
      const controller = new AbortController(), records: EgressRecord[] = [];
      let fences = 0, resultAt = 0, requestReceivedAt = 0, dispatchAt = 0;
      const admissionFencesMs: number[] = [];
      await journal.begin(turnId, { sessionId: null, actor: "interactive", model: "odysseus", profile: "governed", policyHash: null }, error => controller.abort(error));
      await scope.begin(turnId, { sessionId: null, principalId: "captain", origin: "interactive", profile: "governed", policy, source: "default", hardTimeoutMs: 1e6, current: () => !controller.signal.aborted, stop: reason => controller.abort(new Error(reason)) });
      await journal.observe();
      scope.workerStarted(turnId, { freeze: () => true, resume: () => true, kill: () => true, exited: new Promise<number>(() => {}) });
      const proxy = await prepareTurnEgress({ policy, controller, journal, scope,
        turnId, sessionId: () => null, model: () => "odysseus", origin: "interactive", profile: "governed",
        bridge: { emit() {}, requestPermission: async () => ({ behavior: "deny" }) } as unknown as BackendBridge,
        record(event) { if (event.kind === "egress_connection") records.push(event.payload as EgressRecord); return writes.record(event); } });
      const relay = startInferenceRelay({ upstream: origin.url.origin, routes: ["/v1/messages"], credentials: {}, egress: {
        inferenceRoutes: proxy.inferenceRoutes,
        inference(...args) {
          requestReceivedAt = performance.now();
          const operation = proxy.inference(...args);
          return { ...operation, dispatch() { const allowed = operation.dispatch(); if (allowed) dispatchAt = performance.now(); return allowed; }, async admit() {
            fences++; const start = performance.now();
            try { return await operation.admit(); } finally { admissionFencesMs.push(performance.now() - start); }
          } };
        },
      } });
      let observed: Promise<void> | undefined;
      try {
        // Twenty prior completed inference audit rows queue twenty separate
        // FULL commits. No fake writer latency or durability setting is used.
        for (let i = 0; i < 20; i++) proxy.inference("POST", new URL("/v1/messages", origin.url), controller.signal).finish("completed");
        resultAt = performance.now();
        journal.toolStarted(turnId, "loom", "Write", true);
        observed = journal.toolEnded(turnId, "loom");
        if (hold === "drained") { await journalInference(journal)!.flushDeferred(); await observed; await proxy.settled(); }
        await Bun.sleep(Math.max(0, delayMs - (performance.now() - resultAt)));
        const status = await new Promise<number>((resolve, reject) => {
          const outgoing = request({ socketPath: relay.socketPath, path: "/v1/messages", method: "POST" }, response => {
            response.resume(); response.on("error", reject); response.on("end", () => resolve(response.statusCode!));
          }); outgoing.on("error", reject); outgoing.end(JSON.stringify({ model: "odysseus", stream: true, tools: [{ name: "Write" }], messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "loom", name: "Write", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "loom", content: "Ithaca" }] },
          ] }));
        });
        await proxy.settled();
        const measured = records.at(-1)!;
        if (status !== 200 || fences !== 2 || measured.admitMs === undefined || measured.dispatchMs === undefined || measured.credentialMs === undefined) throw Error("Admission join measurement missing a successful request, two fences or marks");
        rows.push({ hold, delayMs, sample, queuedCommits: 20, admitMs: measured.admitMs, credentialToDispatchMs: measured.dispatchMs - measured.credentialMs, fences, admissionFencesMs, requestAfterResultMs: requestReceivedAt - resultAt, dispatchAfterResultMs: dispatchAt - resultAt });
      } finally { relay.stop(); controller.abort(); proxy.stop(); await proxy.settled(); await observed; await journal.finish(turnId); await scope.finish(turnId); }
    }
    return { journalAttached: true, coverage: host ? "native host journal/scope and FULL writer; synthetic twenty-record queue; simulated worker control; no runtime assembly claim" : "real journal/scope with copied checkpoints, FULL writer and Unix relay; synthetic twenty-record queue; simulated worker control", rows };
  } finally { origin.stop(true); if (!host) { scope.close(); await journal.close(); await native!.close(); await writer!.close(); db.close(); } rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw Error("Usage: admission-join.ts <private-existing-output-directory>");
  console.log(JSON.stringify(await measureAdmissionJoin(directory), null, 2));
}

/** Frozen pre-#4300/#4301 consumer fields: new values must stay in optional additions. */
import { expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverActivitySnapshotSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createUiDb } from "../src/db/client.js";
import { toWireSpan, toWireEvent } from "../src/activity/stream.js";
import { createActivityStore } from "../src/activity/store.js";
import { startCronSpan } from "../src/cron/activity.js";
import { runJob } from "../src/cron/run-job.js";
import { createHostBoundary, type HostBoundary } from "../src/brain/host-boundary.js";
import type { ModuleMaintenanceResult } from "../src/brain/module-maintenance.js";

// Closed fields copied from schemas.ts at epic base 134c0eee9. Loose object
// boundaries and open eventType/payload match that published decoder. Keep
// these unions frozen even when the current SDK learns additional values.
const id = z.string().min(1).max(256);
const previousSpan = z.looseObject({
  spanId: id, runId: id, name: z.string(), startedAt: z.number(), endedAt: z.number().optional(),
  kind: z.enum(["turn", "tool", "subagent", "cron"]),
  origin: z.enum(["session", "cron", "autonomous", "compute"]),
  outcome: z.enum(["success", "error", "timeout", "cancelled", "denied", "interrupted"]).optional(),
});
const previousEvent = z.looseObject({ spanId: id, eventIndex: z.number(), ts: z.number(), eventType: z.string(), payload: z.unknown().optional() });
const previousSnapshot = z.looseObject({ type: z.literal("activity_snapshot"), view: z.enum(["index", "session", "run"]),
  spans: z.array(previousSpan), events: z.array(previousEvent), highWaterSeq: z.record(z.string(), z.number()) });
// /status used fetchJson<T>().json(), without a runtime Zod decoder. This
// frozen projection additionally verifies its old closed TypeScript fields;
// unknown optional additions are retained, as the previous HTTP client did.
const previousGoverned = z.looseObject({
  hostExecution: z.enum(["worker", "host"]), available: z.boolean(),
  reason: z.enum(["server_cwd_in_brain", "database_in_brain", "private_state_in_brain", "worker_host_unavailable"]).optional(),
  profile: z.enum(["governed", "strict"]).optional(), configurationView: z.enum(["live", "startup"]).optional(),
  identity: z.enum(["shared_uid", "separate_uid"]).optional(),
  protectedPaths: z.array(z.looseObject({ path: z.string(), reason: z.string(), mode: z.enum(["read_only", "mask_file", "mask_directory", "absent"]) })).optional(),
});
for (const result of ["activated", "unchanged", "failed", "unmanaged"] as const) test(`previous Activity decoder accepts actual cron records for module result ${result}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-module-compat-"));
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  const { runId, rootSpanId } = startCronSpan(db, store, "maintain");
  const receipt: ModuleMaintenanceResult = { result, trigger: "scheduled maintain", ...(result === "failed" ? { detail: "Odysseus install refused" } : {}) };
  const boundary = { isolated: () => true, async launch(execution) {
    execution.observeModuleStore?.(receipt);
    const empty = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    return { stdout: empty(), stderr: empty(), exited: Promise.resolve(0), settled: Promise.resolve(), signalCode: null, kill() {} };
  } } as HostBoundary;
  try {
    const exit = await runJob({ jobName: "maintain", command: ["brain", "maintain"], dbPath: ":memory:", brainPath: root,
      exec: {}, childEnv: {}, boundary, stdout: { write() {} }, stderr: { write() {} } }, {
      sinkPath: join(root, "span-sink"), startRecord: async () => ({
        event(type, payload) { store.appendEvent(rootSpanId, type, payload); },
        finish(error) { store.endSpan(rootSpanId, { outcome: error ? "error" : "success" }); }, close() {},
      }),
    });
    expect(exit).toBe(0);
    const snapshot = store.snapshotRun(runId)!;
    const frame = { type: "activity_snapshot", view: "run", runId, spans: snapshot.spans.map(toWireSpan), events: snapshot.events.map(toWireEvent), highWaterSeq: { [runId]: snapshot.highWaterSeq } };
    expect(previousSnapshot.safeParse(frame).success, "PREVIOUS_SDK_ACCEPTS_MODULE_ACTIVITY_FRAME").toBe(true);
    expect(serverActivitySnapshotSchema.safeParse(frame).success).toBe(true);
    expect(snapshot.events.find(event => event.eventType === "module_store")?.payload).toEqual(receipt);
    expect(snapshot.spans[0]?.outcome, "MODULE_RESULT_DOES_NOT_EXTEND_SPAN_OUTCOME").toBe("success");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
for (const mode of ["walk", "filesystem_identity"] as const) test(`previous HTTP status fields accept the optional proof mode ${mode}`, () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-proof-compat-")), brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(brain); mkdirSync(state);
  try {
    const boundary = createHostBoundary({ brainPath: brain, dbPath: join(state, "ui.db"), workerHost: () => ({ ok: true }) });
    const status = { ...boundary.status(), stateBoundary: { mode, cause: "Odysseus current boundary proof" } };
    const transported = JSON.parse(JSON.stringify(status));
    expect(previousGoverned.safeParse(transported).success, "PREVIOUS_STATUS_FIELDS_ACCEPT_OPTIONAL_PROOF").toBe(true);
    expect(transported.stateBoundary.mode).toBe(mode);
    expect(["strict", "governed"]).toContain(transported.profile);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

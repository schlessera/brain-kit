import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createActivityStore } from "../src/activity/store.js";
import { createOffloopActivityStore } from "../src/activity/store-writes.js";
import { createModelPricing, pricingCachePath } from "../src/pricing/model-pricing.js";
import * as probe from "./fixtures/write-worker-probe.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "activity-offloop-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(brain);
  const db = createUiDb(path), writer = openSqliteWriter(db);
  const store = createOffloopActivityStore(db, writer, { writer: "odysseus-server", pricingConfig: { brainPath: brain, enabled: true } });
  return { root, brain, db, writer, store, async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const root = (runId: string, model = "claude-sonnet-5-5") => ({ spanId: `${runId}:root`, runId, name: "invoke_agent", kind: "turn" as const, origin: "session" as const, sessionId: "ithaca",
  attrs: { "brain.billing_mode": "api", "gen_ai.usage.per_model": { [model]: { inputTokens: 1000, outputTokens: 100 } } } });

test("standalone writes commit on the worker in call order, unawaited", async () => {
  const f = fixture();
  try {
    expect(f.writer.offloop).toBe(true);
    void f.store.startSpan(root("voyage"));
    for (let index = 0; index < 30; index++) void f.store.appendEvent("voyage:root", "log", { index, port: index % 2 ? "Ithaca" : "Troy" });
    void f.store.endSpan("voyage:root", { outcome: "success" });
    await f.store.rollupRun("voyage");
    const snapshot = f.store.snapshotRun("voyage")!;
    expect(snapshot.events.map(event => [event.eventIndex, (event.payload as { index: number }).index]), "ACTIVITY_OFFLOOP_WRITE_ORDER")
      .toEqual(Array.from({ length: 30 }, (_, index) => [index, index]));
    expect(snapshot.spans[0]?.outcome, "ACTIVITY_OFFLOOP_TERMINAL_AFTER_EVENTS").toBe("success");
    expect(f.store.runRollup?.("voyage")?.runId).toBe("voyage");
  } finally { await f.close(); }
});

test("a write inside the caller's transaction stays atomic with it", async () => {
  const f = fixture();
  try {
    const span = f.db.transaction(() => f.store.startSpan(root("kept")))();
    expect((span as { spanId?: string }).spanId, "ACTIVITY_IN_TRANSACTION_WRITE_IS_SYNCHRONOUS").toBe("kept:root");
    expect(() => f.db.transaction(() => { f.store.startSpan(root("rolled-back")); throw new Error("Scylla"); })()).toThrow("Scylla");
    await f.writer.idle();
    expect(f.store.getSpan("rolled-back:root"), "ACTIVITY_IN_TRANSACTION_WRITE_ROLLS_BACK_WITH_CALLER").toBeNull();
    expect(f.store.getSpan("kept:root")?.spanId).toBe("kept:root");
  } finally { await f.close(); }
});

test("clock defaults are taken at submission, not when the worker reaches the write", async () => {
  const f = fixture();
  try {
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    const submitted = Date.now();
    const started = f.store.startSpan({ spanId: "late:root", runId: "late", name: "invoke_agent", kind: "turn", origin: "session" });
    await slow; await started;
    expect(f.store.getSpan("late:root")!.startedAt - submitted, "ACTIVITY_DEFAULT_CLOCK_AT_SUBMISSION").toBeLessThan(150);
  } finally { await f.close(); }
});

test("worker rollups price like the app's store and follow a republished table", async () => {
  const f = fixture();
  const local = createUiDb(join(f.root, "local.db"));
  try {
    const sync = createActivityStore(local, { writer: "odysseus-local", pricing: createModelPricing({ brainPath: f.brain, enabled: true }) });
    for (const store of [sync, f.store]) {
      await store.startSpan(root("priced"));
      await store.endSpan("priced:root", { outcome: "success" });
      await store.rollupRun("priced");
    }
    const worker = f.store.runRollup?.("priced"), app = sync.runRollup?.("priced");
    expect(app?.effectiveCostUsd, "ACTIVITY_SNAPSHOT_PRICES_RUN").toBeGreaterThan(0);
    expect(worker?.effectiveCostUsd, "ACTIVITY_WORKER_PRICES_LIKE_APP").toBe(app!.effectiveCostUsd);
    // The app's refresh republishes the shared on-disk table.
    const cache = pricingCachePath(f.brain); mkdirSync(dirname(cache), { recursive: true });
    const rates = { "claude-sonnet-5-5": { input: 1e-3, output: 1e-3, cacheRead: null, cacheWrite: null } };
    writeFileSync(cache, JSON.stringify({ version: 1, fetchedAt: Date.now(), litellm: { fetchedAt: Date.now(), rates }, openrouter: { fetchedAt: Date.now(), rates } }));
    await f.store.startSpan(root("republished"));
    await f.store.endSpan("republished:root", { outcome: "success" });
    await f.store.rollupRun("republished");
    expect(f.store.runRollup?.("republished")?.effectiveCostUsd, "ACTIVITY_WORKER_RELOADS_PUBLISHED_PRICING").toBeCloseTo(1.1, 6);
  } finally { local.close(); await f.close(); }
});

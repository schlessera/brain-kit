import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import * as sandbox from "../../ui-sdk/src/server/worker-launcher.js";
import { createNativeStartupReleases, setNativeStartupReleases, STARTUP_RELEASE_BACKLOG, type StartupReleaseResult } from "../src/brain/native-startup-releases.js";
import { createGovernedTurns } from "../src/brain/governed-turn.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
const deferred = <T = void>() => Promise.withResolvers<T>();

test("governed admission hands off its checkpoint and records cleanup before delayed native deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-startup-release-")), brain = join(root, "brain");
  const { mkdirSync } = await import("node:fs"); mkdirSync(brain);
  const native = createNativeJournalFixture(brain, root), entered = deferred(), deletion = deferred();
  const results: StartupReleaseResult[] = [], releases = createNativeStartupReleases(result => results.push(result));
  setNativeStartupReleases(native.client, releases);
  const acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async () => {
    const checkpoint = await native.client.checkpoint(crypto.randomUUID());
    return { brain, root: checkpoint.path, storage: { root: checkpoint.path, retain() {}, release() {} }, async cleanup() { entered.resolve(); await deletion.promise; await native.client.release(checkpoint.id); } };
  });
  const managed = spyOn(startup, "assertManagedTurnStartupView").mockImplementation(() => {});
  const resolve = spyOn(sandbox, "prepareWorkerSandboxAsync").mockResolvedValue({ profile: "governed", areas: [], protection: { paths: [] } } as never);
  const execution = { boundary: { async prepare() { return { available: true }; }, maintenance: {} },
    gate() { return { async acquire() { return { release() {} }; } }; },
    manifests() { return { async begin() {}, async end() { return null; } }; } };
  const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, execution: execution as never, profile: "governed", maskPaths: [], async index() {}, report() {} });
  const steps: string[] = [];
  let cleanupMs = -1;
  const admission = turns.begin("voyage", new AbortController().signal, "interactive", "governed", undefined, name => {
    const start = performance.now(); return () => { steps.push(name); if (name === "startup_view_cleanup") cleanupMs = performance.now() - start; };
  });
  try {
    await entered.promise;
    // Drain ready admission continuations once. The old awaited cleanup
    // cannot pass this boundary while deletion is gated.
    const result = await Promise.race([admission.then(hold => ({ kind: "admitted" as const, hold })), new Promise<{ kind: "blocked" }>(resolve => setImmediate(() => resolve({ kind: "blocked" })))]);
    expect(result.kind, "ADMISSION_DOES_NOT_WAIT_FOR_CHECKPOINT_DELETION").toBe("admitted");
    expect(steps, "STARTUP_CLEANUP_HANDOFF_RECORDED").toContain("startup_view_cleanup");
    expect(cleanupMs, "STARTUP_CLEANUP_IS_HANDOFF_ONLY").toBeGreaterThanOrEqual(0);
    expect(releases.pending(), "BACKGROUND_OWNER_RETAINS_CHECKPOINT").toBe(1);
    deletion.resolve(); await releases.drain();
    const hold = await admission; await hold.end();
    expect(results.map(result => result.outcome)).toEqual(["released"]);
    expect((await native.client.listRecovery()).records).toEqual([]);
  } finally { deletion.resolve(); await admission.then(hold => hold.end(), () => {}); await turns.close(); acquire.mockRestore(); managed.mockRestore(); resolve.mockRestore(); await native.close(); rmSync(root, { recursive: true, force: true }); }
});

test("startup release failure is recorded and retried while reservation retains its owner", async () => {
  const results: StartupReleaseResult[] = [], releases = createNativeStartupReleases(result => results.push(result));
  let attempts = 0;
  const view = { root: "/odysseus/checkpoint", async cleanup() { if (++attempts === 1) throw new Error("EIO"); } } as startup.WorkerStartupView;
  const slot = await releases.reserve(); slot.handoff("voyage", view);
  try {
    // First drain joins the failed background attempt, preserving its cause.
    const failed = await releases.drain().then(() => null, error => String(error));
    expect(failed, "RELEASE_FAILURE_IS_NOT_CLEAN").toContain("EIO");
    expect(releases.pending(), "FAILED_RELEASE_REMAINS_OWNED").toBe(1);
    await releases.drain();
    expect(releases.pending()).toBe(0);
    expect(results.map(result => [result.outcome, result.attempt])).toEqual([["retry", 1], ["released", 2]]);
    expect(results[0]?.cause).toContain("EIO");
  } finally { await releases.close(); }
});

test("ten simultaneous admissions keep at most two startup releases pending", async () => {
  const releases = createNativeStartupReleases(), deletion = deferred();
  const full = deferred(); let maximum = 0;
  const work = Array.from({ length: 10 }, async (_, i) => {
    const slot = await releases.reserve();
    slot.handoff(`voyage-${i}`, { root: `/odysseus/${i}`, cleanup: () => deletion.promise } as startup.WorkerStartupView);
    maximum = Math.max(maximum, releases.pending());
    if (releases.pending() === STARTUP_RELEASE_BACKLOG) full.resolve();
  });
  try {
    await full.promise;
    expect(releases.pending(), "STARTUP_RELEASE_BACKLOG_BOUNDED").toBe(2);
    deletion.resolve(); await Promise.all(work); await releases.drain();
    expect(maximum, "STARTUP_RELEASE_BACKLOG_BOUNDED").toBe(2);
  } finally { deletion.resolve(); await Promise.all(work); await releases.close(); }
});

test("an observation reserves behind a delayed startup release without inheriting its cleanup failure", async () => {
  const { createNativeJournalObserver } = await import("../src/brain/native-journal-observer.js");
  const { mkdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "odysseus-startup-reserve-")), brain = join(root, "brain"); mkdirSync(brain);
  const native = createNativeJournalFixture(brain, root), queue = createNativeStartupReleases(), deletion = deferred(), entered = deferred();
  setNativeStartupReleases(native.manager, queue);
  const observer = createNativeJournalObserver(native.manager);
  const steps: string[] = [];
  try {
    await observer.initialize();
    const slot = await queue.reserve();
    slot.handoff("voyage", { root: "/odysseus/checkpoint", async cleanup() { entered.resolve(); await deletion.promise; throw new Error("EIO"); } } as startup.WorkerStartupView);
    await entered.promise;
    let observed = false;
    const work = observer.observe(undefined, name => () => { steps.push(name); }).then(value => { observed = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(observed, "OBSERVATION_WAITS_FOR_STARTUP_RELEASE").toBe(false);
    deletion.resolve(); const observation = await work;
    expect(steps, "OBSERVE_RESERVE_MEASURES_THE_RELEASE_WAIT").toContain("observe_reserve");
    expect(queue.pending(), "FAILED_RELEASE_REMAINS_CHARGED").toBe(1);
    await observation.commit();
    expect(observed, "CLEANUP_FAILURE_DOES_NOT_FAIL_RUNNING_TURN").toBe(true);
  } finally { deletion.resolve(); await observer.close(); await queue.close().catch(() => {}); await native.close(); rmSync(root, { recursive: true, force: true }); }
});

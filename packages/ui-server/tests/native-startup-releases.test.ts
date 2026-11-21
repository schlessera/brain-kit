import { watchdogMs } from "../../../scripts/test-deadlines.js";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import * as sandbox from "../../ui-sdk/src/server/worker-launcher.js";
import { createNativeStartupReleases, setNativeStartupReleases, STARTUP_RELEASE_BACKLOG, STARTUP_QUALIFICATION_BACKLOG, type StartupReleaseResult } from "../src/brain/native-startup-releases.js";
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

test("ten simultaneous healthy admissions bound every pinned qualification and ordinary release", async () => {
  const { createUiDb } = await import("../src/db/client.js"), { createWriterGate } = await import("../src/brain/writer-gate.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-ten-qualifications-")), brain = join(root, "brain"); mkdirSync(brain);
  const native = createNativeJournalFixture(brain, root), db = createUiDb(":memory:"), gate = createWriterGate(db, brain, { pollMs: 1 });
  const deletion = deferred(), full = deferred(), waiting = deferred(), results: StartupReleaseResult[] = [];
  const queue = createNativeStartupReleases(result => results.push(result), 1); setNativeStartupReleases(native.client, queue);
  let views = 0, maximum = 0, deleting = 0, maxDeleting = 0, created = 0, waits = 0;
  const reserveOriginal = queue.reserve.bind(queue), reserve = spyOn(queue, "reserve").mockImplementation((signal, disposal) => { if (++waits === 2) waiting.resolve(); return reserveOriginal(signal, disposal); });
  const witness = () => { maximum = Math.max(maximum, views); expect(views, "QUALIFICATION_PLUS_RELEASE_TOTAL_PIN_BOUND_AT_EVERY_TRANSITION").toBeLessThanOrEqual(STARTUP_RELEASE_BACKLOG + STARTUP_QUALIFICATION_BACKLOG); };
  const acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async () => {
    const cp = await native.client.checkpoint(crypto.randomUUID()); views++; ++created; witness();
    if (created === STARTUP_RELEASE_BACKLOG + STARTUP_QUALIFICATION_BACKLOG) full.resolve();
    return { brain, root: cp.path, storage: { root: cp.path, retain() {}, release() {} }, async cleanup() {
      deleting++; maxDeleting = Math.max(maxDeleting, deleting);
      expect(deleting, "EVERY_DELETION_USES_THE_TWO_RELEASE_OWNERS").toBeLessThanOrEqual(STARTUP_RELEASE_BACKLOG);
      try { await deletion.promise; await native.client.release(cp.id); views--; witness(); }
      finally { deleting--; }
    } };
  });
  const managed = spyOn(startup, "assertManagedTurnStartupView").mockImplementation(() => {}), resolve = spyOn(sandbox, "prepareWorkerSandboxAsync").mockResolvedValue({ profile: "governed", areas: [], protection: { paths: [] } } as never);
  const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, profile: "governed", maskPaths: [], async index() {}, report() {}, execution: {
    gate() { return gate; }, boundary: { async prepare() { return { available: true }; }, maintenance: {} }, manifests() { return { async begin() {}, async end() { return null; } }; },
  } as never });
  const work = Array.from({ length: 10 }, (_, i) => turns.begin(`voyage-${i}`, new AbortController().signal).then(async hold => { await hold.end(); return { hold, error: null }; }, error => ({ hold: null, error: String(error) })));
  try {
    await full.promise; await waiting.promise; await new Promise<void>(r => setImmediate(r));
    expect(views, "ONLY_FOUR_CHECKPOINTS_PINNED_WITH_TEN_QUICK_TURNS").toBe(4);
    expect(created, "QUALIFICATION_WAIT_CREATES_NO_VIEW").toBe(4);
    expect(queue.pending()).toBe(2);
    expect(db.query("SELECT count(*) AS n FROM writer_gate").get(), "QUALIFICATION_AND_RELEASE_WAITS_HOLD_NO_WRITER_GATE").toEqual({ n: 0 });
    deletion.resolve(); const settled = await Promise.all(work);
    for (const row of settled) await row.hold?.end();
    await queue.drain();
    expect(settled.map(row => row.error)).toEqual(Array(10).fill(null));
    expect(results.filter(row => row.outcome === "released")).toHaveLength(10);
    expect(views).toBe(0); expect(maximum).toBe(4); expect(maxDeleting).toBe(2);
    expect((await native.client.listRecovery()).records).toEqual([]);
  } finally { deletion.resolve(); for (const row of await Promise.all(work)) await row.hold?.end(); await turns.close(); reserve.mockRestore(); acquire.mockRestore(); managed.mockRestore(); resolve.mockRestore(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const pressure of [false, true]) test(`observation requests native capacity before waiting for startup release: pressure=${pressure}`, async () => {
  const { createNativeJournalObserver } = await import("../src/brain/native-journal-observer.js");
  const { mkdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "odysseus-startup-reserve-")), brain = join(root, "brain"); mkdirSync(brain);
  const native = createNativeJournalFixture(brain, root), queue = createNativeStartupReleases(), deletion = deferred(), entered = deferred(), refused = deferred(), reclaiming = deferred();
  setNativeStartupReleases(native.manager, queue);
  const originalReclaim = queue.reclaim;
  const reclaim = spyOn(queue, "reclaim").mockImplementation(signal => { reclaiming.resolve(); return originalReclaim(signal); });
  const observer = createNativeJournalObserver(native.manager);
  const original = native.manager.checkpoint;
  let room = !pressure, attempts = 0;
  let work: ReturnType<typeof observer.observe> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await observer.initialize();
    native.manager.checkpoint = async (...args) => {
      attempts++;
      if (!room) { refused.resolve(); throw Object.assign(new Error("native capacity"), { code: "capacity" }); }
      return original(...args);
    };
    const slot = await queue.reserve();
    slot.handoff("voyage", { brain, root: "/odysseus/checkpoint", storage: { root: "/odysseus/checkpoint", retain() {}, release() {} }, async cleanup() { entered.resolve(); await deletion.promise; room = true; } });
    await entered.promise;
    work = observer.observe(); void work.catch(() => {});
    if (pressure) {
      await refused.promise; await reclaiming.promise;
      expect(attempts, "CAPACITY_IS_TRIED_BEFORE_RELEASE_WAIT").toBe(1);
      // Resolve a fresh native checkpoint directly as an independent witness:
      // this observer's successful second attempt cannot occur before deletion.
      expect(queue.pending(), "CAPACITY_RELEASE_STILL_OWNED").toBe(1);
      let done = false; void work.then(() => { done = true; }, () => { done = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(done, "CAPACITY_RETRY_REMAINS_PENDING_UNTIL_RELEASE").toBe(false);
      expect(attempts, "CAPACITY_RETRY_NEVER_RUNS_BEFORE_SPACE_RECLAIMED").toBe(1);
      deletion.resolve();
      const outcome = await work.then(value => ({ value, error: null }), error => ({ value: null, error: String(error) }));
      expect(outcome.error, "CAPACITY_RETRY_JOINS_PENDING_RELEASE").toBeNull();
      expect(attempts, "CHECKPOINT_RETRIED_AFTER_SPACE_RECLAIMED").toBe(2);
      await outcome.value!.commit();
    } else {
      const observed = await Promise.race([work.then(value => ({ value })), new Promise<{ value: null }>(resolve => watchdog = setTimeout(() => resolve({ value: null }), watchdogMs(5000)))]);
      expect(observed.value, "AVAILABLE_ROOM_COMPLETES_WITH_DELETION_GATED").not.toBeNull();
      const outcome = observed.value!;
      expect(attempts, "AVAILABLE_ROOM_DOES_NOT_JOIN_DELETION").toBe(1);
      expect(queue.pending()).toBe(1); await outcome.commit();
    }
  } finally { clearTimeout(watchdog); deletion.resolve(); await work?.then(value => value.abort().catch(() => {}), () => {}); await observer.close(); reclaim.mockRestore(); await queue.close(); await native.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a waiting admission takes the first freed slot and cancellation does not wait for another deletion", async () => {
  const queue = createNativeStartupReleases(), first = deferred(), second = deferred();
  for (const [i, gate] of [first, second].entries()) {
    const slot = await queue.reserve(); slot.handoff(`voyage-${i}`, { root: `/odysseus/${i}`, cleanup: () => gate.promise } as startup.WorkerStartupView);
  }
  const waiting = queue.reserve();
  let acquired: Awaited<typeof waiting> | undefined;
  try {
    first.resolve();
    const answer = await Promise.race([waiting.then(slot => ({ slot })), new Promise<{ slot: null }>(resolve => setImmediate(() => resolve({ slot: null })))]);
    expect(answer.slot, "FIRST_FREE_SLOT_DOES_NOT_WAIT_FOR_OTHER_RELEASE").not.toBeNull(); acquired = answer.slot!;
    const abort = new AbortController(), stopped = queue.reserve(abort.signal).then(() => "acquired", error => error);
    const reason = new Error("cancel admission"); abort.abort(reason);
    const cancellation = await Promise.race([stopped, new Promise<string>(resolve => setImmediate(() => resolve("still waiting")))]);
    expect(cancellation, "RELEASE_SLOT_WAIT_OBSERVES_CANCELLATION").toBe(reason);
  } finally { first.resolve(); second.resolve(); acquired?.release(); (await waiting).release(); await queue.close(); }
});

for (const mode of ["strict", "masked"] as const) test(`${mode} admission retains its startup view without taking a background-release slot`, async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const trees = await import("../src/brain/turn-data-tree.js"), caches = await import("../src/brain/private-index-cache.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-retained-startup-")), brain = join(root, "brain"); mkdirSync(brain);
  if (mode === "masked") {
    mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(brain, "me"));
    writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }]\n---\n");
  }
  const native = createNativeJournalFixture(brain, root), queue = createNativeStartupReleases(), deletion = deferred();
  setNativeStartupReleases(native.client, queue);
  for (const id of ["earlier-one", "earlier-two"]) { const slot = await queue.reserve(); slot.handoff(id, { root: `/odysseus/${id}`, cleanup: () => deletion.promise } as startup.WorkerStartupView); }
  const reserve = spyOn(queue, "reserve").mockRejectedValue(new Error("excluded admission took a release slot"));
  const acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async () => {
    const checkpoint = await native.client.checkpoint(crypto.randomUUID());
    return { brain, root: checkpoint.path, storage: { root: checkpoint.path, retain() {}, release() {} }, async cleanup() { await native.client.release(checkpoint.id); } };
  });
  const managed = spyOn(startup, "assertManagedTurnStartupView").mockImplementation(() => {});
  const resolve = spyOn(sandbox, "prepareWorkerSandboxAsync").mockResolvedValue({ profile: mode === "strict" ? "strict" : "governed", areas: [], protection: { paths: [] } } as never);
  const tree = spyOn(trees, "createTurnDataTree").mockResolvedValue({ async close() {} } as never);
  const cache = spyOn(caches, "createPrivateIndexCache").mockReturnValue({ async prepare() { return { kind: "reused" }; }, async close() {}, async advance() {} } as never);
  const execution = { boundary: { async prepare() { return { available: true }; }, maintenance: {} },
    gate() { return { async acquire() { return { release() {}, assertPeerFolderPlans() {} }; } }; },
    manifests() { return { async begin() {}, async end() { return null; } }; } };
  const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, execution: execution as never, profile: mode === "strict" ? "strict" : "governed", maskPaths: [], async index() {}, report() {} });
  try {
    const result = await turns.begin("voyage", new AbortController().signal).then(hold => ({ hold, error: null }), error => ({ hold: null, error: String(error) }));
    expect(result.error, "RETAINED_VIEW_ADMISSION_IGNORES_RELEASE_BACKLOG").toBeNull();
    expect(reserve, "RETAINED_VIEW_ADMISSION_TAKES_NO_RELEASE_SLOT").not.toHaveBeenCalled();
    expect(result.hold?.dataTree).toBeDefined(); expect(queue.pending()).toBe(2);
    await expect(result.hold!.end(), "RETAINED_CONSUMER_END_NEVER_RESERVES_A_RELEASE_SLOT").resolves.toBeNull();
    expect(queue.pending()).toBe(2);
  } finally { deletion.resolve(); await turns.close(); reserve.mockRestore(); acquire.mockRestore(); managed.mockRestore(); resolve.mockRestore(); tree.mockRestore(); cache.mockRestore(); await native.close(); rmSync(root, { recursive: true, force: true }); }
});

test("release frees its slot before reporting while close joins the durable receipt", async () => {
  const entered = deferred(), report = deferred();
  const queue = createNativeStartupReleases(async () => { entered.resolve(); await report.promise; });
  const slot = await queue.reserve(); slot.handoff("voyage", { root: "/odysseus/checkpoint", async cleanup() {} } as startup.WorkerStartupView);
  let closed = false;
  try {
    await entered.promise; expect(queue.pending()).toBe(0);
    const next = await queue.reserve(); next.release();
    const closing = queue.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed, "CLOSE_JOINS_RELEASE_RECEIPT").toBe(false);
    report.resolve(); await closing;
  } finally { report.resolve(); await queue.close(); }
});


test("early policy failure releases the admission gate and index watermark", async () => {
  const governance = await import("../src/brain/governance-policy.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-policy-admission-")), brain = join(root, "brain"); mkdirSync(brain);
  const native = createNativeJournalFixture(brain, root), reader = governance.governancePolicyReaderFor(brain);
  const load = spyOn(reader, "load").mockImplementation(() => { throw new Error("policy read EIO"); });
  let released = 0, watermarks = 0;
  const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, profile: "governed", maskPaths: [], async index() {}, report() {},
    indexBatch: { watermark() { return { release() { watermarks++; } }; } } as never,
    execution: { gate() { return { async acquire() { return { release() { released++; } }; } }; }, manifests() { return {}; } } as never });
  try {
    await expect(turns.begin("voyage", new AbortController().signal)).rejects.toThrow("policy read EIO");
    expect(released, "EARLY_POLICY_FAILURE_RELEASES_ADMISSION_GATE").toBe(1);
    expect(watermarks, "EARLY_POLICY_FAILURE_RELEASES_INDEX_WATERMARK").toBe(1);
  } finally { load.mockRestore(); await turns.close(); await native.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["empty_paths", "boundary_fallback"] as const) test(`resolved startup branch gets correct release ownership: ${mode}`, async () => {
  const trees = await import("../src/brain/turn-data-tree.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-resolved-view-")), brain = join(root, "brain"); mkdirSync(join(brain, "context/policies"), { recursive: true });
  if (mode === "empty_paths") writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [], allow: [] }]\n---\n");
  const native = createNativeJournalFixture(brain, root), queue = createNativeStartupReleases(), deletion = deferred(); setNativeStartupReleases(native.client, queue);
  if (mode === "boundary_fallback") for (const id of ["one", "two"]) (await queue.reserve()).handoff(id, { root: id, cleanup: () => deletion.promise } as startup.WorkerStartupView);
  const tryReserve = spyOn(queue, "tryReserve"), reserve = spyOn(queue, "reserve").mockRejectedValue(new Error("retained profile waited for release"));
  const acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async () => {
    const cp = await native.client.checkpoint(crypto.randomUUID()); return { brain, root: cp.path, storage: { root: cp.path, retain() {}, release() {} }, async cleanup() { await native.client.release(cp.id); } };
  });
  const managed = spyOn(startup, "assertManagedTurnStartupView").mockImplementation(() => {});
  const resolve = spyOn(sandbox, "prepareWorkerSandboxAsync").mockImplementation(async (_path, options) => ({ profile: options!.profile, areas: [], protection: { paths: [] } }) as never);
  const tree = spyOn(trees, "createTurnDataTree").mockResolvedValue({ async close() {} } as never);
  const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, profile: "governed", maskPaths: [], async index() {}, report() {}, execution: {
    boundary: { async prepare() { return { available: mode !== "boundary_fallback", detail: "Ithaca boundary unavailable" }; }, maintenance: {} },
    gate() { return { async acquire() { return { release() {} }; } }; }, manifests() { return { async begin() {}, async end() { return null; } }; },
  } as never });
  try {
    const result = await turns.begin("voyage", new AbortController().signal).then(hold => ({ hold, error: null }), error => ({ hold: null, error: String(error) }));
    expect(result.error, mode === "empty_paths" ? "EMPTY_PROVIDER_PATHS_HAVE_RELEASE_OWNER" : "BOUNDARY_FALLBACK_IGNORES_RELEASE_BACKLOG").toBeNull();
    expect(reserve).not.toHaveBeenCalled();
    if (mode === "boundary_fallback") { expect(tryReserve, "FALLBACK_RETAINS_VIEW_WITHOUT_RELEASE_SLOT").not.toHaveBeenCalled(); expect(result.hold?.dataTree).toBeDefined(); }
    else expect(tryReserve, "UNMASKED_EMPTY_RULE_HANDS_OFF_VIEW").toHaveBeenCalledTimes(1);
    await expect(result.hold!.end(), "RETAINED_CONSUMER_END_NEVER_RESERVES_A_RELEASE_SLOT").resolves.toBeNull();
    if (mode !== "empty_paths") expect(queue.pending()).toBe(2);
  } finally { deletion.resolve(); await turns.close(); tryReserve.mockRestore(); reserve.mockRestore(); acquire.mockRestore(); managed.mockRestore(); resolve.mockRestore(); tree.mockRestore(); await native.close(); rmSync(root, { recursive: true, force: true }); }
});

test("three type-selector admissions finish peer plans before waiting outside the writer gate", async () => {
  const { createUiDb } = await import("../src/db/client.js"), { createWriterGate } = await import("../src/brain/writer-gate.js"), translation = await import("../src/brain/provider-types.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-release-peer-")), brain = join(root, "brain"); mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(brain, "me"));
  writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ types: [identity], allow: [anthropic] }]\n---\n");
  const db = createUiDb(":memory:"), gate = createWriterGate(db, brain, { pollMs: 1 });
  const native = createNativeJournalFixture(brain, root), queue = createNativeStartupReleases(), deletion = deferred(), prepared = deferred(), waiting = deferred(); setNativeStartupReleases(native.client, queue);
  for (const id of ["one", "two"]) (await queue.reserve()).handoff(id, { root: id, cleanup: () => deletion.promise } as startup.WorkerStartupView);
  let checkpoints = 0, waits = 0, views = 0; const recordedPolicies: string[] = [];
  const reserveOriginal = queue.reserve.bind(queue), reserve = spyOn(queue, "reserve").mockImplementation(signal => { if (++waits === STARTUP_QUALIFICATION_BACKLOG) waiting.resolve(); return reserveOriginal(signal); });
  const acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async () => {
    const cp = await native.client.checkpoint(crypto.randomUUID()); views++; ++checkpoints;
    return { brain, root: cp.path, storage: { root: cp.path, retain() {}, release() {} }, async cleanup() { await native.client.release(cp.id); views--; } };
  });
  const managed = spyOn(startup, "assertManagedTurnStartupView").mockImplementation(() => {});
  const resolve = spyOn(sandbox, "prepareWorkerSandboxAsync").mockResolvedValue({ profile: "governed", areas: [], protection: { paths: [] } } as never);
  const translated = spyOn(translation, "translateProviderTypesInView").mockResolvedValue({ folders: { identity: ["me"] }, refused: [] });
  const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, profile: "governed", maskPaths: [], async index() {}, report() {},
    recordPolicy(id) { recordedPolicies.push(id); },
    exposures: { async settled() {}, forSessions() { return []; }, async record() {} } as never, peerFolderPlanWaitMs: watchdogMs(10000), execution: {
      gate() { return gate; }, boundary: { async prepare() { return { available: true }; }, maintenance: {} }, manifests() { return { async begin() {}, async end() { return null; }, appearedIn() { return false; } }; },
    } as never });
  const work = Array.from({ length: 3 }, (_, i) => turns.begin(`voyage-${i}`, abort.signal, "interactive", "governed", { inferenceOrigin: "https://api.anthropic.com" }).then(hold => ({ hold, error: null }), error => ({ hold: null, error })));
  try {
    const reached = await Promise.race([waiting.promise.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), watchdogMs(5000)); })]);
    expect(reached, "ADMITTED_QUALIFIERS_FINISH_PEER_PLANS_WITH_RELEASE_SLOTS_FULL").toBe(true);
    expect(db.query("SELECT count(*) AS n FROM writer_gate").get(), "RELEASE_CAPACITY_WAIT_HOLDS_NO_WRITER_GATE").toEqual({ n: 0 });
    expect(views, "RELEASE_CAPACITY_WAIT_HAS_BOUNDED_QUALIFICATION_OWNERS").toBe(STARTUP_QUALIFICATION_BACKLOG);
    expect(checkpoints, "THIRD_QUALIFIER_WAITS_BEFORE_GATE_AND_VIEW_CREATION").toBe(STARTUP_QUALIFICATION_BACKLOG);
    expect(queue.pending()).toBe(2);
    deletion.resolve(); const result = await Promise.all(work); expect(result.map(item => item.error), "PEER_ADMISSIONS_RECOVER_WITHOUT_TIMEOUT").toEqual([null,null,null]);
    expect(recordedPolicies.sort(), "THROWAWAY_PROBE_DOES_NOT_RECORD_A_TURN_POLICY").toEqual(["voyage-0", "voyage-1", "voyage-2"]);
    for (const item of result) await item.hold!.end();
  } finally { clearTimeout(timer); prepared.resolve(); deletion.resolve(); abort.abort(); for (const item of await Promise.all(work)) await item.hold?.end(); await turns.close(); reserve.mockRestore(); acquire.mockRestore(); managed.mockRestore(); resolve.mockRestore(); translated.mockRestore(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});


for (const mode of ["strict", "masked", "failed_admission"] as const) test(`excluded cleanup never waits for ordinary release slots and owns failed retries: ${mode}`, async () => {
  const trees = await import("../src/brain/turn-data-tree.js"), caches = await import("../src/brain/private-index-cache.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-excluded-cleanup-")), brain = join(root, "brain"); mkdirSync(brain);
  if (mode === "masked") { mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(brain, "me")); writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }]\n---\n"); }
  const native = createNativeJournalFixture(brain, root), normalDeletion = deferred(), retryEntered = deferred(), retryDeletion = deferred(), retryDone = deferred(), results: StartupReleaseResult[] = [];
  const queue = createNativeStartupReleases(row => results.push(row), 1); setNativeStartupReleases(native.client, queue);
  for (const id of ["earlier-one", "earlier-two"]) (await queue.reserve()).handoff(id, { root: id, cleanup: () => normalDeletion.promise } as startup.WorkerStartupView);
  const reserve = spyOn(queue, "reserve").mockRejectedValue(new Error("excluded cleanup requested a release slot")); let attempts = 0;
  const acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async () => {
    const cp = await native.client.checkpoint(crypto.randomUUID());
    return { brain, root: cp.path, storage: { root: cp.path, retain() {}, release() {} }, async cleanup() { if (++attempts === 1) throw new Error("excluded view EIO"); retryEntered.resolve(); await retryDeletion.promise; await native.client.release(cp.id); retryDone.resolve(); } };
  });
  const managed = spyOn(startup, "assertManagedTurnStartupView").mockImplementation(() => {}), resolve = spyOn(sandbox, "prepareWorkerSandboxAsync").mockResolvedValue({ profile: mode === "strict" ? "strict" : "governed", areas: [], protection: { paths: [] } } as never);
  const tree = spyOn(trees, "createTurnDataTree").mockResolvedValue({ async close() {} } as never), cache = spyOn(caches, "createPrivateIndexCache").mockReturnValue({ async prepare() { return { kind: "reused" }; }, async close() {}, async advance() {} } as never);
  const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, profile: mode === "strict" ? "strict" : "governed", maskPaths: [], async index() {}, report() {}, execution: {
    boundary: { async prepare() { if (mode === "failed_admission") throw new Error("qualification refused"); return { available: true }; }, maintenance: {} },
    gate() { return { async acquire() { return { release() {}, assertPeerFolderPlans() {} }; } }; }, manifests() { return { async begin() {}, async end() { return null; } }; },
  } as never });
  let hold: Awaited<ReturnType<typeof turns.begin>> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const end = mode === "failed_admission" ? turns.begin("voyage", new AbortController().signal).then(() => "unexpected admission", error => String(error))
      : turns.begin("voyage", new AbortController().signal).then(async value => { hold = value; await value.end(); return "ended"; }).catch(error => String(error));
    const outcome = await Promise.race([end, new Promise<string>(r => { timer = setTimeout(() => r("still waiting"), watchdogMs(5000)); })]); clearTimeout(timer);
    expect(outcome, "EXCLUDED_END_SETTLES_WITH_UNRELATED_RELEASES_STILL_BLOCKED").toBe(mode === "failed_admission" ? "Error: qualification refused" : "ended");
    expect(reserve, "EXCLUDED_END_DOES_NOT_RESERVE_A_RELEASE_SLOT").not.toHaveBeenCalled();
    expect(queue.pending(), "FAILED_EXCLUDED_VIEW_HAS_AN_OWNER_WITHOUT_A_SLOT").toBe(3);
    const retried = await Promise.race([retryEntered.promise.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), watchdogMs(5000)); })]); clearTimeout(timer);
    expect(retried, "FAILED_EXCLUDED_VIEW_RETRIES_BEFORE_UNRELATED_RELEASES_COMPLETE").toBe(true);
    retryDeletion.resolve(); await retryDone.promise; await new Promise<void>(r => setImmediate(r));
    expect(queue.pending()).toBe(2);
    expect(results.filter(row => row.turnId === "voyage").map(row => [row.outcome, row.attempt]), "EXCLUDED_RETRY_RECORDS_CAUSE_AND_SUCCESS").toEqual([["retry", 1], ["released", 2]]);
    expect((await native.client.listRecovery()).records).toEqual([]);
  } finally { clearTimeout(timer); normalDeletion.resolve(); retryDeletion.resolve(); await hold?.end(); await turns.close(); reserve.mockRestore(); acquire.mockRestore(); managed.mockRestore(); resolve.mockRestore(); tree.mockRestore(); cache.mockRestore(); await native.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["release_wait", "checkpoint_refresh"] as const) test(`reacquired peer folder plans cannot launch the old sandbox: ${mode}`, async () => {
  const trees = await import("../src/brain/turn-data-tree.js");
  const { createUiDb } = await import("../src/db/client.js"), { createWriterGate } = await import("../src/brain/writer-gate.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-reacquired-plan-")), brain = join(root, "brain"); mkdirSync(brain);
  const db = createUiDb(":memory:"), gate = createWriterGate(db, brain, { pollMs: 1 }), native = createNativeJournalFixture(brain, root), queue = createNativeStartupReleases(); setNativeStartupReleases(native.client, queue);
  const first = deferred(), second = deferred(), waiting = deferred(); let peer: Awaited<ReturnType<typeof gate.acquire>> | undefined, checkpoints = 0, policies = 0;
  if (mode === "release_wait") for (const [i, deletion] of [first, second].entries()) (await queue.reserve()).handoff(`earlier-${i}`, { root: `earlier-${i}`, cleanup: () => deletion.promise } as startup.WorkerStartupView);
  const reserveOriginal = queue.reserve.bind(queue), reserve = spyOn(queue, "reserve").mockImplementation((signal, disposal) => { if (!disposal) waiting.resolve(); return reserveOriginal(signal, disposal); });
  const addPeerPlan = async () => { peer = await gate.acquire("shared", "turn:athena", { turn: true }); await peer.retainFolders!(["peer-root"]); };
  const acquire = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async () => {
    const cp = await native.client.checkpoint(crypto.randomUUID()); checkpoints++;
    return { brain, root: cp.path, storage: { root: cp.path, retain() {}, release() {} }, async cleanup() { await native.client.release(cp.id); if (mode === "checkpoint_refresh" && !peer) await addPeerPlan(); } };
  });
  const managed = spyOn(startup, "assertManagedTurnStartupView").mockImplementation(() => {});
  const resolve = spyOn(sandbox, "prepareWorkerSandboxAsync").mockImplementation(async () => {
    if (mode === "checkpoint_refresh") { mkdirSync(join(brain, ".brain/scratch"), { recursive: true }); return { profile: "strict", areas: [{ rel: ".brain/scratch", mount: { writable: true } }], protection: { paths: [] } } as never; }
    return { profile: "governed", areas: [], protection: { paths: [] } } as never;
  });
  const tree = spyOn(trees, "createTurnDataTree").mockResolvedValue({ async close() {} } as never);
  const turns = createGovernedTurns({ nativeManager: native.client, brainPath: brain, profile: mode === "checkpoint_refresh" ? "strict" : "governed", maskPaths: [], async index() {}, report() {}, recordPolicy() { policies++; }, execution: {
    gate() { return gate; }, boundary: { async prepare() { return { available: true }; }, maintenance: {} }, manifests() { return { async begin() {}, async end() { return null; } }; },
  } as never });
  const admission = turns.begin("voyage", new AbortController().signal).then(hold => ({ hold, error: null }), error => ({ hold: null, error: String(error) }));
  try {
    if (mode === "release_wait") { await waiting.promise; await addPeerPlan(); first.resolve(); }
    const result = await admission;
    expect(result.error ?? "", "REACQUIRED_FOLDER_PLAN_REQUIRES_FRESH_ADMISSION").toContain("Writer folder plan changed");
    expect(result.hold, "OLD_MOUNTS_ARE_NEVER_LAUNCHED_AGAINST_A_NEW_RECORDED_PLAN").toBeNull();
    expect(policies).toBe(0); expect(checkpoints).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM writer_gate WHERE purpose='turn:voyage'").get()).toEqual({ n: 0 });
  } finally { first.resolve(); second.resolve(); await peer?.release(); await admission.then(value => value.hold?.end()); await turns.close(); reserve.mockRestore(); acquire.mockRestore(); managed.mockRestore(); resolve.mockRestore(); tree.mockRestore(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

/** Actual launcher → deferred backend → shared reconciler, with a scripted supervisor. */
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as internal from "@schlessera/brain-ui-sdk/internal";
import * as identity from "../../ui-sdk/src/server/worker-identity.js";
import { workerStep, type WorkerSteps } from "../../ui-sdk/src/server/worker-steps.js";
import { createWorkerSpawn } from "../src/worker-spawn.js";
const MiB = 1024 * 1024;

for (const mode of ["eventual", "shutdown", "ordinary"] as const) test(`failed launch cleanup ${mode} retains its actual owner`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-launch-cleanup-"));
  const brain = join(root, "brain"); mkdirSync(brain);
  const ledger = internal.createStateLedger(), notices: unknown[] = [], logs: string[] = [];
  let releases = 0;
  const reserve = ledger.reserve.bind(ledger);
  const reservation = spyOn(ledger, "reserve").mockImplementation((...args) => {
    const held = reserve(...args); return { ...held, release() { releases++; held.release(); } };
  });
  let progress = Promise.withResolvers<void>();
  const pending: Array<{ run(): void; cancelled: boolean; delay: number }> = [];
  const cleanup = internal.createCleanupReconciler({ log: message => logs.push(message), schedule: (run, delay) => {
    const task = { run, cancelled: false, delay }; pending.push(task); progress.resolve(); return () => { task.cancelled = true; };
  } });
  const host = spyOn(internal, "requireWorkerHostAsync").mockResolvedValue({ ok: true });
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue("/usr/lib/odysseus/identity-helper");
  const prepare = identity.prepareWorkerIdentity;
  const brokers: ReturnType<typeof prepare>[] = [];
  let closes = 0;
  const gate = Promise.withResolvers<void>();
  const seam = spyOn(identity, "prepareWorkerIdentity").mockImplementation((...args) => {
    const broker = prepare(...args); brokers.push(broker);
    return { ...broker, command: ["/bin/sleep", "30"],
      *readySteps(): WorkerSteps<ReturnType<typeof broker.ready>> {
        return yield* workerStep(() => { throw new Error("Odysseus setup refused"); },
          async () => { throw new Error("Odysseus setup refused"); });
      },
      *closeSteps(): WorkerSteps<void> {
        closes++;
        if (mode === "shutdown" && closes > 1) { progress.resolve(); yield* workerStep(() => {}, () => gate.promise); }
        else if (mode !== "ordinary" && closes <= 8) throw new Error("Odysseus cleanup unconfirmed");
        broker.discard();
      } };
  });
  const tick = async () => {
    const task = pending.shift();
    if (!task || task.cancelled) return;
    progress = Promise.withResolvers<void>(); task.run(); await progress.promise;
  };
  try {
    const spawner = createWorkerSpawn(brain, {}, new AbortController().signal, undefined,
      { brain, profile: "governed", restricted: false, scratchAliasesRemoved: [], areas: [] } as never, undefined, undefined,
      { ledger, cleanup, reportCleanup: notice => { notices.push(notice); if (notice.state === "resolved") progress.resolve(); },
        limits: { allowanceBytes: 4 * MiB, budgetBytes: 8 * MiB }, turnTempLimits: { allowanceBytes: MiB, budgetBytes: 2 * MiB } });
    const child = spawner.spawn({ command: "/bin/true", args: [], env: { HOME: root }, signal: new AbortController().signal } as never);
    child.on("error", () => {});
    await spawner.finish();
    const failure = spawner.startFailure();
    expect(String(failure)).toContain("Odysseus setup refused");
    expect(closes).toBe(1);
    if (mode === "ordinary") {
      expect(ledger.live).toBe(0); expect(releases).toBe(1); expect(cleanup.held).toBe(0); expect(pending).toHaveLength(0);
      expect(internal.workerCleanupUnconfirmed(failure)).toBe(false);
      return;
    }
    expect(internal.workerCleanupUnconfirmed(failure)).toBe(true);
    const close = (failure as { close?: () => Promise<void> }).close;
    expect(typeof close, "FAILED_LAUNCH_EXPOSES_OWNED_CLOSE").toBe("function");
    expect(ledger.held).toBe(4 * MiB); expect(ledger.turnTempHeld).toBe(MiB);
    if (mode === "shutdown") {
      await tick();
      const concurrent = close!();
      expect(closes, "FAILED_LAUNCH_CLOSE_COALESCES").toBe(2);
      expect(cleanup.close()).toEqual({ held: 1, bytes: 4 * MiB, turnTempBytes: MiB });
      gate.resolve(); await concurrent;
      expect(releases, "LATE_LAUNCH_CONFIRMATION_AFTER_SHUTDOWN_STAYS_CHARGED").toBe(0);
      expect(ledger.live).toBe(1);
      expect(notices).toHaveLength(1);
      return;
    }
    for (let i = 0; i < 7; i++) {
      await tick(); expect(ledger.live, "FAILED_LAUNCH_RETRY_REFUSAL_STAYS_CHARGED").toBe(1); expect(releases).toBe(0);
    }
    const finalDelay = pending[0]?.delay;
    await tick();
    // This is the handoff mutation's accounting oracle, not just an owner-count assertion.
    expect(ledger.live, "FAILED_LAUNCH_CONFIRMED_RETRY_RELEASES_RESERVATION").toBe(0);
    expect(releases).toBe(1); expect(ledger.held).toBe(0); expect(ledger.turnTempHeld).toBe(0);
    expect(logs.some(line => line.includes("reconciliation continues"))).toBe(true);
    expect(finalDelay).toBe(30_000);
    await Promise.all([close!(), close!()]);
    expect(closes, "CONFIRMED_FAILED_LAUNCH_CLOSE_IS_IDEMPOTENT").toBe(9);
    expect(releases).toBe(1); expect(pending).toHaveLength(0);
    expect(notices).toMatchObject([{ state: "retrying", message: expect.stringContaining("Odysseus cleanup unconfirmed") }, { state: "resolved" }]);
  } finally {
    gate.resolve(); cleanup.close(); seam.mockRestore(); helper.mockRestore(); host.mockRestore(); reservation.mockRestore();
    for (const broker of brokers) broker.discard(); rmSync(root, { recursive: true, force: true });
  }
});

for (const prepared of [true, false]) test(`strict failed launch retains ${prepared ? "prepared output" : "startup checkpoint"} until cleanup confirms`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-strict-cleanup-")), brain = join(root, "brain"); mkdirSync(brain); mkdirSync(join(brain, "workspaces"));
  const actualFs = fs.statfsSync(brain), statfs = spyOn(fs, "statfsSync").mockReturnValue({ ...actualFs, type: 0x9123683e });
  const ledger = internal.createStateLedger(), stagingBefore = internal.processStateLedger().outputStagingHeld;
  let progress = Promise.withResolvers<void>();
  const pending: Array<() => void> = [];
  const cleanup = internal.createCleanupReconciler({ log() {}, schedule: run => {
    pending.push(run); progress.resolve(); return () => {};
  } });
  const tick = async () => { const run = pending.shift()!; progress = Promise.withResolvers<void>(); run(); await progress.promise; };
  let checkpointPath = "", stagePath = "", closes = 0, stageDeletes = 0, checkpointDeletes = 0;
  let supervisorConfirmed = false, teardown = false;
  const manager = {
    async checkpoint(id: string) {
      checkpointPath = join(root, ".brain-native", "checkpoints", id); mkdirSync(checkpointPath, { recursive: true });
      return { id, path: checkpointPath, readOnly: true as const, sourceUuid: "0123456789abcdef0123456789abcdef", fsid: "00000000-0000-0000-0000-000000000001",
        uuid: "00000000000000000000000000000002", rootId: "256", transaction: "12" };
    },
    async release(id: string) {
      if (!teardown && ++checkpointDeletes === 1) throw Error("checkpoint deletion unconfirmed");
      rmSync(checkpointPath, { recursive: true, force: true }); return { id, state: "deleted" as const };
    },
    async prepareStage(id: string, checkpointId: string, allowanceBytes: number) {
      stagePath = join(root, ".brain-native", "stages", id); mkdirSync(join(stagePath, "merged"), { recursive: true });
      const info = fs.lstatSync(stagePath, { bigint: true });
      const start = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19]!;
      return { id, checkpointId, checkpointUuid: "00000000000000000000000000000002", sourceUuid: "0123456789abcdef0123456789abcdef",
        path: stagePath, namespacePid: process.pid, namespaceStart: start, appUid: process.getuid!(), appGid: process.getgid!(),
        allowanceBytes, rootDevice: String(info.dev), rootInode: String(info.ino) };
    },
    async releaseStage(id: string) {
      // A premature caller really deletes the directory: the test must catch
      // that effect, rather than have the double enforce the guard for it.
      if (!teardown && supervisorConfirmed && ++stageDeletes === 1) throw Error("stage deletion unconfirmed");
      rmSync(stagePath, { recursive: true, force: true }); return { id, state: "deleted" as const };
    },
    async inspectStage(): Promise<never> { throw Error("failed launches cannot publish"); },
  };
  const view = await internal.prepareNativeWorkerStartupView(brain, manager);
  const host = spyOn(internal, "requireWorkerHostAsync").mockResolvedValue({ ok: true });
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue("/usr/lib/odysseus/identity-helper");
  const prepare = identity.prepareWorkerIdentity, brokers: ReturnType<typeof prepare>[] = [];
  const seam = spyOn(identity, "prepareWorkerIdentity").mockImplementation((...args) => {
    const broker = prepare(...args); brokers.push(broker);
    return { ...broker, command: ["/bin/sleep", "30"],
      *readySteps(): WorkerSteps<ReturnType<typeof broker.ready>> {
        return yield* workerStep(() => { throw Error("Odysseus strict setup refused"); }, async () => { throw Error("Odysseus strict setup refused"); });
      },
      *closeSteps(): WorkerSteps<void> {
        const close = () => {
          if (++closes <= 2) throw Error("supervisor cleanup unconfirmed");
          supervisorConfirmed = true; broker.discard();
        };
        yield* workerStep(close, async () => close());
      } };
  });
  const prepareOutput = internal.prepareNativeWorkerOutput;
  let output: internal.PreparedWorkerOutput | undefined;
  const preparation = spyOn(internal, "prepareNativeWorkerOutput").mockImplementation(async (...args) => {
    // Only native acquisition is doubled with owned directories. Production
    // preparation, reference counting, cleanup and accounting stay in use.
    helper.mockReturnValue(undefined);
    try { return output = await prepareOutput(...args); }
    finally { helper.mockReturnValue("/usr/lib/odysseus/identity-helper"); }
  });
  try {
    const spawner = createWorkerSpawn(brain, {}, new AbortController().signal, undefined,
      { brain, profile: "strict", restricted: false, scratchAliasesRemoved: [], areas: prepared
        ? [{ name: "workspaces", rel: "workspaces", mount: { path: join(brain, "workspaces"), writable: true } }] : [] } as never,
      undefined, undefined, { ledger, cleanup, reportCleanup: notice => { if (notice.state === "resolved") progress.resolve(); },
        limits: { allowanceBytes: 4 * MiB, budgetBytes: 8 * MiB }, turnTempLimits: { allowanceBytes: MiB, budgetBytes: 2 * MiB } },
      undefined, undefined, view);
    const child = spawner.spawn({ command: "/bin/true", args: [], env: { HOME: root }, signal: new AbortController().signal } as never);
    child.on("error", () => {});
    const failure = await spawner.finish().then(() => spawner.startFailure(), error => error);
    expect(String(failure)).toContain("Odysseus strict setup refused");
    expect(closes, "STRICT_LAUNCH_REACHED_OWNED_SUPERVISOR").toBe(1);
    expect(internal.workerCleanupUnconfirmed(failure)).toBe(true);
    if (prepared) {
      expect(fs.existsSync(stagePath), "STRICT_FAILED_LAUNCH_OUTPUT_NOT_DELETED_BY_OUTER_CATCH").toBe(true);
      expect(internal.processStateLedger().outputStagingHeld).toBeGreaterThan(stagingBefore);
    }
    await view.cleanup(); // Only the failed launch's retained reference remains.
    expect(fs.existsSync(checkpointPath)).toBe(true);
    await tick(); // Supervisor still refuses: resources remain owned.
    expect(ledger.live).toBe(1); expect(fs.existsSync(checkpointPath)).toBe(true);
    await tick(); // Supervisor confirms, required resource deletion refuses.
    expect(ledger.live, "STRICT_FAILED_LAUNCH_RESOURCE_REFUSAL_RETAINS_RESERVATION").toBe(1);
    expect(fs.existsSync(checkpointPath)).toBe(true);
    if (prepared) {
      expect(fs.existsSync(stagePath)).toBe(true);
      expect(internal.processStateLedger().outputStagingHeld).toBeGreaterThan(stagingBefore);
      await tick(); // Stage confirms; final checkpoint deletion refuses.
      expect(fs.existsSync(stagePath)).toBe(false);
      expect(internal.processStateLedger().outputStagingHeld).toBe(stagingBefore);
      expect(ledger.live, "STRICT_FAILED_LAUNCH_CHECKPOINT_REFUSAL_RETAINS_RESERVATION").toBe(1);
      expect(fs.existsSync(checkpointPath)).toBe(true);
    }
    await tick();
    expect(fs.existsSync(checkpointPath), "STRICT_FAILED_LAUNCH_CHECKPOINT_CONFIRMED").toBe(false);
    expect(ledger.held).toBe(0); expect(ledger.turnTempHeld).toBe(0); expect(cleanup.held).toBe(0); expect(pending).toHaveLength(0);
  } finally {
    teardown = true; cleanup.close();
    try { await output?.cleanup(); await view.storage.release(); }
    finally { preparation.mockRestore(); seam.mockRestore(); helper.mockRestore(); host.mockRestore(); statfs.mockRestore();
      for (const broker of brokers) broker.discard(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("Claude reports a stranded launch charge once without scheduling an impossible close", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-stranded-")), brain = join(root, "brain"), ledger = internal.createStateLedger();
  mkdirSync(brain);
  const failure = new identity.WorkerIdentityCleanupError("Odysseus legacy cleanup unconfirmed");
  let schedules = 0;
  const cleanup = internal.createCleanupReconciler({ schedule: () => { schedules++; return () => {}; }, log() {} });
  const host = spyOn(internal, "requireWorkerHostAsync").mockResolvedValue({ ok: true });
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockRejectedValue(failure);
  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation(chunk => { diagnostics.push(String(chunk)); return true; });
  try {
    const spawner = createWorkerSpawn(brain, {}, new AbortController().signal, undefined,
      { brain, profile: "governed", restricted: false, scratchAliasesRemoved: [], areas: [] } as never,
      undefined, undefined, { ledger, cleanup, limits: { allowanceBytes: 4 * MiB, budgetBytes: 8 * MiB },
        turnTempLimits: { allowanceBytes: MiB, budgetBytes: 2 * MiB } });
    const child = spawner.spawn({ command: "/bin/true", args: [], env: { HOME: root }, signal: new AbortController().signal } as never);
    child.on("error", () => {}); await spawner.finish(); await spawner.finish();
    expect(spawner.startFailure()).toBe(failure);
    expect(ledger.held).toBe(4 * MiB); expect(ledger.turnTempHeld).toBe(MiB);
    expect(schedules, "NO_FUTILE_CLAUDE_CLEANUP_RETRY").toBe(0); expect(cleanup.held).toBe(0);
    expect(diagnostics, "CLAUDE_STRANDED_CHARGE_HAS_ONE_DIAGNOSTIC").toHaveLength(1);
    expect(JSON.parse(diagnostics[0]!)).toMatchObject({ kind: "worker_cleanup_stranded", backend: "claude", reason: "missing_retryable_close",
      bytes: 4 * MiB, turnTempBytes: MiB, errorClass: "WorkerIdentityCleanupError", message: String(failure) });
  } finally { cleanup.close(); stderr.mockRestore(); launch.mockRestore(); host.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

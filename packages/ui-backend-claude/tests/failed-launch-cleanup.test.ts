/** Actual launcher → deferred backend → shared reconciler, with a scripted supervisor. */
import { expect, spyOn, test } from "bun:test";
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

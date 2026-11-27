/**
 * A refused end-of-turn Claude worker cleanup is handed to the shared
 * reconciler (#2871), which releases the reservation only after a retry is
 * confirmed. The reconciler's own retry rules are tested in ui-sdk.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as internal from "@schlessera/brain-ui-sdk/internal";
import { createCleanupReconciler, createStateLedger, type CleanupReconcilerOptions } from "@schlessera/brain-ui-sdk/internal";
import { createWorkerSpawn } from "../src/worker-spawn.js";

const MiB = 1024 * 1024;
const refusal = () => Object.assign(new Error("worker_identity_cleanup_unconfirmed: Odysseus fixture"), { cleanupUnconfirmed: true });

/** Retries run only when the test says so; delays are recorded. */
function manualClock() {
  const pending: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  const schedule: NonNullable<CleanupReconcilerOptions["schedule"]> = (run, delayMs) => {
    const entry = { run, delayMs, cancelled: false };
    pending.push(entry);
    return () => { entry.cancelled = true; };
  };
  return {
    schedule,
    delays: () => pending.map(entry => entry.delayMs),
    live: () => pending.filter(entry => !entry.cancelled).length,
    /** Runs every retry scheduled so far, then lets their closes settle. */
    async tick() {
      for (const entry of pending.splice(0)) if (!entry.cancelled) entry.run();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await Bun.sleep(0);
    },
  };
}

/** A worker whose handles behave as the launcher's; only its turn temp's awaited close is scripted. */
function fakeLaunch(root: string, turnTempClose: () => Promise<void>) {
  const handle = (name: string, closeAsync: () => Promise<void>) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return { root: path, space: () => ({ total: 4 * MiB, free: 4 * MiB }), close() {}, closeAsync };
  };
  return spyOn(internal, "launchAgentWorkerAsync").mockImplementation((async () => {
    const stderr = new PassThrough(), stdout = new PassThrough(), stdin = new PassThrough();
    stderr.end(); stdout.end();
    return { pid: 0, exited: Promise.resolve(0), released: async () => {}, kill() {}, stdin, stdout, stderr,
      limitReport: () => ({}), state: handle("state", async () => {}), turnTemp: handle("tmp", turnTempClose) };
  }) as never);
}

test("a turn whose end-of-turn cleanup is refused hands it to the reconciler, which releases the reservation once a retry confirms", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-cleanup-retry-"));
  const brain = join(root, "brain"), inferenceDir = join(root, "inference");
  mkdirSync(brain); mkdirSync(inferenceDir);
  const host = spyOn(internal, "requireWorkerHostAsync").mockImplementation((async () => {}) as never);
  let refusals = 2, closes = 0;
  const launch = fakeLaunch(root, async () => { closes++; if (refusals-- > 0) throw refusal(); });
  const clock = manualClock();
  const cleanup = createCleanupReconciler({ attempts: 3, baseDelayMs: 1, schedule: clock.schedule, log: () => {} });
  const ledger = createStateLedger();
  const notices: unknown[] = [];
  try {
    const spawner = createWorkerSpawn(brain, {}, new AbortController().signal, { inferenceDir }, undefined, undefined, undefined,
      { ledger, cleanup, reportCleanup: notice => notices.push(notice), limits: { allowanceBytes: 4 * MiB, budgetBytes: 8 * MiB }, turnTempLimits: { allowanceBytes: MiB, budgetBytes: 2 * MiB } });
    const child = spawner.spawn({ command: "/bin/true", args: [], env: { HOME: root }, signal: new AbortController().signal } as never);
    child.on("error", () => {});
    await expect(spawner.finish(), "REFUSED_CLEANUP_STILL_FAILS_THE_TURN").rejects.toThrow("worker_identity_cleanup_unconfirmed");
    expect(closes, "TURN_CLOSED_ONCE").toBe(1);
    expect(ledger.live, "REFUSED_CLEANUP_KEEPS_RESERVATION").toBe(1);
    expect(cleanup.held, "REFUSED_CLEANUP_HANDED_TO_RECONCILER").toBe(1);
    await clock.tick();
    expect(closes, "RECONCILER_RETRIES_THE_TURN_TEMP_CLOSE").toBe(2);
    expect(ledger.live, "RESERVATION_HELD_WHILE_RETRY_REFUSED").toBe(1);
    await clock.tick();
    expect(closes, "SECOND_RETRY_CONFIRMS").toBe(3);
    expect(ledger.live, "CONFIRMED_RETRY_RELEASES_RESERVATION").toBe(0);
    expect(ledger.held, "NO_RUNTIME_STATE_STILL_CHARGED").toBe(0);
    expect(ledger.turnTempHeld, "NO_TURN_TEMP_STILL_CHARGED").toBe(0);
    expect(cleanup.held, "RECONCILER_NO_LONGER_HOLDS_IT").toBe(0);
    expect(notices).toMatchObject([{ state: "retrying", message: expect.stringContaining("worker_identity_cleanup_unconfirmed") }, { state: "resolved" }]);
  } finally { launch.mockRestore(); host.mockRestore(); cleanup.close(); rmSync(root, { recursive: true, force: true }); }
});

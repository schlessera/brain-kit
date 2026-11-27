/**
 * A refused end-of-turn worker cleanup has an owner (#2871): the
 * reconciler retains the retryable close and the reservation, retries with
 * capped backoff without giving up, and releases exactly once, only after a close
 * is confirmed. Shutdown neither releases nor waits.
 */
import { expect, test } from "bun:test";
import { createCleanupReconciler, type CleanupReconcilerOptions, type RetainedCleanup } from "../src/server/cleanup-reconciler.js";

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

function refusingCleanup(refusals: number) {
  let calls = 0, released = 0;
  const cleanup: RetainedCleanup = { bytes: 4 * MiB, turnTempBytes: MiB,
    close: async () => { calls++; if (calls <= refusals) throw refusal(); },
    release: () => { released++; } };
  return { cleanup, calls: () => calls, released: () => released };
}

test("a cleanup refused N times is retried with backoff and released exactly once, only after confirmation", async () => {
  const clock = manualClock(), logs: string[] = [];
  const reconciler = createCleanupReconciler({ attempts: 5, baseDelayMs: 10, maxDelayMs: 25, schedule: clock.schedule, log: message => { logs.push(message); } });
  const fixture = refusingCleanup(3);
  reconciler.retain(fixture.cleanup);
  reconciler.retain(fixture.cleanup);
  expect(fixture.calls(), "RETAIN_DOES_NOT_CLOSE_SYNCHRONOUSLY").toBe(0);
  for (let refused = 1; refused <= 3; refused++) {
    await clock.tick();
    expect(fixture.calls(), "ONE_CLOSE_PER_RETRY").toBe(refused);
    expect(fixture.released(), "RESERVATION_HELD_WHILE_CLOSE_REFUSED").toBe(0);
    expect(reconciler.held, "RECONCILER_KEEPS_THE_REFUSED_CLEANUP").toBe(1);
  }
  await clock.tick();
  expect(fixture.calls(), "CONFIRMING_CLOSE_ATTEMPTED").toBe(4);
  expect(fixture.released(), "CONFIRMED_CLOSE_RELEASES_ONCE").toBe(1);
  expect(reconciler.held, "CONFIRMED_CLEANUP_NO_LONGER_HELD").toBe(0);
  expect(clock.delays(), "NO_RETRY_AFTER_CONFIRMATION").toEqual([]);
  // Repeated retention and shutdown after confirmation release nothing again.
  reconciler.retain(fixture.cleanup);
  reconciler.close();
  await clock.tick();
  expect(fixture.released(), "RELEASED_EXACTLY_ONCE").toBe(1);
  expect(logs.filter(line => line.includes("after")), "NO_TERMINAL_FAILURE_ON_CONFIRMATION").toEqual([]);
});

test("retry delays double from the base and stop at the maximum", async () => {
  const clock = manualClock(), seen: number[] = [];
  const schedule: NonNullable<CleanupReconcilerOptions["schedule"]> = (run, delayMs) => { seen.push(delayMs); return clock.schedule(run, delayMs); };
  const reconciler = createCleanupReconciler({ attempts: 5, baseDelayMs: 10, maxDelayMs: 25, schedule, log: () => {} });
  reconciler.retain(refusingCleanup(Infinity).cleanup);
  for (let i = 0; i < 6; i++) await clock.tick();
  expect(seen, "BOUNDED_EXPONENTIAL_BACKOFF").toEqual([10, 20, 25, 25, 25, 25, 25]);
  reconciler.close();
});

test("a cleanup refused beyond the foreground limit keeps retrying and releases only on confirmation", async () => {
  const clock = manualClock(), logs: Array<{ message: string; error: unknown }> = [];
  const reconciler = createCleanupReconciler({ attempts: 3, baseDelayMs: 1, schedule: clock.schedule, log: (message, error) => { logs.push({ message, error }); } });
  const fixture = refusingCleanup(6);
  reconciler.retain(fixture.cleanup);
  for (let i = 0; i < 6; i++) await clock.tick();
  expect(fixture.calls(), "RETRIES_BEYOND_FOREGROUND_LIMIT").toBe(6);
  expect(clock.live(), "RECONCILIATION_REMAINS_OWNED").toBe(1);
  expect(fixture.released(), "TERMINAL_FAILURE_NEVER_RELEASES").toBe(0);
  expect(reconciler.held, "TERMINAL_FAILURE_STAYS_HELD").toBe(1);
  expect(logs.length, "TERMINAL_FAILURE_LOGGED_ONCE").toBe(1);
  expect(logs[0]!.message, "TERMINAL_FAILURE_NAMES_THE_HELD_ALLOWANCE").toContain("4 MiB of runtime state and 1 MiB of turn temp stay charged");
  expect(String(logs[0]!.error), "TERMINAL_FAILURE_KEEPS_THE_CAUSE").toContain("worker_identity_cleanup_unconfirmed");
  await clock.tick();
  expect(fixture.released(), "LATE_CONFIRMATION_RELEASES_ONCE").toBe(1);
  expect(reconciler.held).toBe(0);
  await clock.tick();
  expect(fixture.released()).toBe(1);
  reconciler.close();
});

test("shutdown during a retry neither releases nor waits for the close in flight", async () => {
  const clock = manualClock(), logs: string[] = [];
  const reconciler = createCleanupReconciler({ attempts: 5, baseDelayMs: 1, schedule: clock.schedule, log: message => { logs.push(message); } });
  const gate = Promise.withResolvers<void>();
  let released = 0, calls = 0;
  const inFlight: RetainedCleanup = { bytes: 2 * MiB, turnTempBytes: MiB, close: () => { calls++; return gate.promise; }, release: () => { released++; } };
  const waiting = refusingCleanup(0);
  reconciler.retain(inFlight);
  await clock.tick();
  expect(calls, "CLOSE_IN_FLIGHT").toBe(1);
  reconciler.retain(waiting.cleanup);
  // Synchronous: it cannot wait for the held close.
  const summary = reconciler.close();
  expect(summary, "SHUTDOWN_REPORTS_EVERYTHING_HELD").toEqual({ held: 2, bytes: 6 * MiB, turnTempBytes: 2 * MiB });
  expect(logs.some(line => line.includes("stopped with 2 unconfirmed cleanups")), "SHUTDOWN_LOGS_WHAT_IS_HELD").toBe(true);
  expect(clock.live(), "SHUTDOWN_CANCELS_RETRY_TIMERS").toBe(0);
  gate.resolve();
  await clock.tick();
  expect(released, "SHUTDOWN_DOES_NOT_RELEASE_A_CLOSE_CONFIRMED_AFTER_IT").toBe(0);
  expect(waiting.calls(), "SHUTDOWN_CANCELS_PENDING_RETRIES").toBe(0);
  expect(waiting.released(), "SHUTDOWN_RELEASES_NOTHING").toBe(0);
  expect(reconciler.close().held, "SHUTDOWN_IS_IDEMPOTENT").toBe(2);
});

// Hosted selection witness for #4192: this changed spec is repeated by the PR's
// own browser_determinism job. Ordinary browser proof keeps factor one. Timing
// assertions use controlled clocks; only hang-catching defaults are scaled.
import { expect, test, vi } from "vitest";
import { deadlineFactor, watchdogMs } from "../../../../scripts/test-deadlines";

test("the crew's watchdog follows the loaded run in every pass", ({ task }) => {
  expect(task.timeout, "BROWSER_TEST_DEFAULT_SCALES").toBe(15_000 * deadlineFactor());
  expect(watchdogMs(37), "BROWSER_WATCHDOG_READS_FACTOR").toBe(37 * deadlineFactor());
});

test("an explicit per-test timeout keeps its written value", { timeout: 2_000 }, ({ task }) => {
  expect(task.timeout, "EXPLICIT_TIMEOUT_IS_UNSCALED").toBe(2_000);
});

test("product timings stay on controlled time", () => {
  vi.useFakeTimers();
  try {
    let ready = false;
    setTimeout(() => { ready = true; }, 600);
    vi.advanceTimersByTime(599);
    expect(ready).toBe(false);
    vi.advanceTimersByTime(1);
    expect(ready).toBe(true);
  } finally { vi.useRealTimers(); }
});

for (const wait of ["poll", "waitFor"] as const) {
  test(`${wait} keeps its explicit timeout independently of project defaults`, async () => {
    let ready = false;
    const timer = setTimeout(() => { ready = true; }, 200);
    try {
      // If the 80 ms wait were multiplied by three, readiness at 200 ms would
      // make it pass; rejection proves it kept its own limit.
      const result = wait === "poll"
        ? expect.poll(() => ready, { timeout: 80, interval: 10 }).toBe(true)
        : vi.waitFor(() => { expect(ready).toBe(true); }, { timeout: 80, interval: 10 });
      await expect(result).rejects.toThrow();
    } finally { clearTimeout(timer); }
  });
}

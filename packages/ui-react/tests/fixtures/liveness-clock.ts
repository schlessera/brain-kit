import type { Page } from "playwright";

/** Establish the liveness fixture clock before application timers exist. */
export async function installPausedLivenessClock(page: Page): Promise<void> {
  const time = new Date("2026-07-12T12:00:00Z");
  await page.clock.install({ time });
  // Keep the pause target invariant while protocol commands are in flight.
  // No application timers exist yet. Fixed Date still lets performance/timers
  // advance until pauseAt completes; there is no delivery-time margin.
  await page.clock.setFixedTime(time);
  await page.clock.pauseAt(time);
  // Restore normal Date/timer coupling while the clock remains paused.
  await page.clock.setSystemTime(time);
}

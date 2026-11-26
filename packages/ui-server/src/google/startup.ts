import type { createGoogleStateWrites } from "./state-writes.js";

/** Failed startup cleanup restricts only Google writes. Mechanical recovery is
 * retried with capped backoff; the owner's host log retains each cause. */
export async function initializeGoogleWrites(state: ReturnType<typeof createGoogleStateWrites>, report: (message: string) => void, clearOldAllowances: () => Promise<void> = async () => {}) {
  let ready = false, closed = false, delay = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const initialize = async () => {
    try {
      await clearOldAllowances();
      await state.clearSendLocksAtHostStart();
      await state.pruneExpiredInverses(Date.now());
      ready = !closed;
    } catch (cause) {
      try { report(`Google writes unavailable (state_unavailable): ${String(cause)}`); } catch { /* Logging cannot stop boot/recovery. */ }
      if (!closed) {
        timer = setTimeout(() => { void initialize(); }, delay);
        timer.unref?.();
        delay = Math.min(30_000, delay * 2);
      }
    }
  };
  await initialize();
  return { ready: () => ready, close: () => { closed = true; ready = false; clearTimeout(timer); } };
}

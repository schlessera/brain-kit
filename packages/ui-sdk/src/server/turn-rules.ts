/** Turn rules both backends must apply the same way, beside the seam they serve. */
import type { ServerMessage } from "../protocol.js";

/**
 * @experimental Backend toolkit; may change before 1.0.
 *
 * The session-id test: an anchored, case-insensitive UUID.
 */
export function isSessionUuid(id: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
}

/**
 * @experimental Backend toolkit; may change before 1.0.
 *
 * The autonomous yield wrapper: the first yield of a live turn calls `onYield`,
 * emits `AUTONOMOUS_YIELD_FAILED` when it throws, and then aborts the turn.
 * Later yields, and a yield after the turn stopped, do nothing. `onYield` is
 * the turn's `AutonomousTurnOptions.onYield`, `aborted` says whether the turn
 * already stopped, and `abort` is how this runtime stops it.
 */
export function autonomousYieldLatch(options: {
  onYield: (key: string) => void;
  aborted: () => boolean;
  emit: (message: ServerMessage) => void;
  abort: () => void;
}): (key: string) => void {
  let yielded = false;
  return (key) => {
    if (yielded || options.aborted()) return;
    yielded = true;
    try { options.onYield(key); }
    catch { options.emit({ type: "error", code: "AUTONOMOUS_YIELD_FAILED", message: "Autonomous yield checkpoint failed." }); }
    finally { options.abort(); }
  };
}

/**
 * @experimental Backend toolkit; may change before 1.0.
 *
 * A token count for the `first_request_cache` activity event: a non-negative
 * safe integer, or `null` for anything else.
 */
export function usageTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

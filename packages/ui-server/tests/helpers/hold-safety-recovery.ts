import type { Database } from "bun:sqlite";
import { safetyQueue } from "../../src/governance/safety-queue";

/** Keeps the automatic recorder recovery (#3812) from racing a test that
 * drives recovery by hand. It occupies the reconciler's one timer slot. */
export function holdSafetyRecovery(db: Database): void {
  const state = safetyQueue(db).recovery;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {}, 2 ** 31 - 1);
  (state.timer as { unref?: () => void }).unref?.();
}

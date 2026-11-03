import type { TestContext } from "vitest";
import { createBrainUiRoot } from "../../../src/root.js";
import { createLocalPartitions } from "../../../src/lib/local-partitions.js";
import { createRecordingStore, type RecordingEvent } from "../../../src/lib/recordings.js";

/** Fresh root, store and IndexedDB namespace for each recording proof. */
export function recordingCell(ctx: TestContext) {
  let held: string | null = "odysseus";
  const name = `odysseus-recordings-${crypto.randomUUID()}`;
  const partitions = createLocalPartitions({ name, heldAccountKey: () => held });
  const root = createBrainUiRoot({ storage: null });
  const store = createRecordingStore({ root, partitions, heldAccountKey: () => held });
  const events: RecordingEvent[] = [];
  const cleanup: Array<() => void> = [];
  store.onEvent((event) => events.push(event));
  const committedCount = () => events.filter((event) => event.kind === "committed").length;
  /**
   * Resolves when the store has emitted at least `count` committed events.
   * Native capture commits in real time, so a fixed polling window measures
   * runner load rather than the precondition; the test timeout stays the
   * only failure bound. The recorder above runs first, so `events` already
   * holds the event a later listener is told about.
   */
  const committed = (count: number) => new Promise<void>((resolve) => {
    if (committedCount() >= count) return resolve();
    const unsubscribe = store.onEvent(() => {
      if (committedCount() < count) return;
      unsubscribe();
      resolve();
    });
    cleanup.push(unsubscribe);
  });
  ctx.onTestFinished(async () => {
    const failures: unknown[] = [];
    for (const finish of [...cleanup.reverse(), () => store.stop("interrupted"), () => store.dispose(), () => root.dispose()]) {
      try { await finish(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Recording fixture cleanup failed");
  });
  return { root, partitions, store, events, committed, committedCount, cleanup, account: (key: string | null) => { held = key; root.stores.connection.getState().setVpnStatus(key ? "connected" : "unauthorized", key); } };
}

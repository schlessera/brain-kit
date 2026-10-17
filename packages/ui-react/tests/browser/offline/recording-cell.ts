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
  ctx.onTestFinished(async () => {
    const failures: unknown[] = [];
    for (const finish of [...cleanup.reverse(), () => store.stop("interrupted"), () => store.dispose(), () => root.dispose()]) {
      try { await finish(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Recording fixture cleanup failed");
  });
  return { root, partitions, store, events, cleanup, account: (key: string | null) => { held = key; root.stores.connection.getState().setVpnStatus(key ? "connected" : "unauthorized", key); } };
}

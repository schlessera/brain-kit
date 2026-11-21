import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchdogMs } from "../../../scripts/test-deadlines.ts";
import { createActivityStream } from "../src/activity/stream.js";
import { createOffloopActivityStore } from "../src/activity/store-writes.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import * as probe from "./fixtures/client-turn-writer-probe.js";

for (const reader of ["empty pump", "single lifecycle", "lifecycle list", "lifecycle snapshot", "single paired lifecycle snapshot", "lifecycle deltas", "span snapshot"] as const) {
  test(`${reader} reads its snapshot while the file-backed writer remains held`, async () => {
    const folder = mkdtempSync(join(tmpdir(), "client-turn-ithaca-read-"));
    const db = createUiDb(join(folder, "ui.db")), writer = openSqliteWriter(db);
    const store = createOffloopActivityStore(db, writer);
    const gate = new Int32Array(new SharedArrayBuffer(12));
    const release = () => { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); };
    let held: Promise<unknown> | undefined;
    let stream: ReturnType<typeof createActivityStream> | undefined;
    try {
      expect(writer.offloop).toBe(true);
      const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", 1000, () => {}, () => 1100, "odysseus");
      lifecycle.finish("success"); await lifecycle.settled();
      const timing = { sendToFirstHostFrameMs: 7 };
      expect(await store.writeClientReceipt!("turn-ithaca", "odysseus", timing)).toBe(true);
      const frames: string[] = [];
      if (reader === "empty pump") {
        stream = createActivityStream(store);
        stream.handleSubscribe({ send: frame => { frames.push(frame); } }, { type: "activity_subscribe", view: "index" }, "odysseus");
        expect(stream.subscriptionCount()).toBe(1);
      }
      const frameCount = frames.length;
      const channel = writer.channel(probe, {}); await channel.ready;
      held = channel.call("hold", gate, watchdogMs(10000));
      const entering = Atomics.waitAsync(gate, 0, 0); if (entering.async) await entering.value;
      switch (reader) {
        case "empty pump": stream!.pump(); expect(frames).toHaveLength(frameCount); break;
        case "single lifecycle": expect(store.lifecycle("turn-ithaca")?.clientTiming).toEqual(timing); break;
        case "lifecycle list": expect(store.lifecycles("ithaca")[0]?.clientTiming).toEqual(timing); break;
        case "lifecycle snapshot": {
          const snapshot = store.snapshotLifecycles!({ turnId: "turn-ithaca" });
          expect(snapshot.lifecycles[0]?.clientTiming).toEqual(timing);
          expect(snapshot.highWaterSeq["lifecycle:turn-ithaca"]).toBeGreaterThan(0);
          break;
        }
        case "single paired lifecycle snapshot": {
          const snapshot = store.lifecycleSnapshot!("turn-ithaca")!;
          expect(snapshot.lifecycle.clientTiming).toEqual(timing);
          expect(snapshot.highWaterSeq).toBeGreaterThan(0);
          break;
        }
        case "lifecycle deltas": expect(store.lifecycleChangesSince(0).at(-1)?.lifecycle.clientTiming).toEqual(timing); break;
        case "span snapshot": expect(store.snapshotRun("turn-ithaca")).toBeNull(); break;
      }
      expect(Atomics.load(gate, 2), "READ_PRECEDES_HELD_WRITER_RELEASE").toBe(0);
    } finally {
      release(); await held; stream?.close(); await writer.close(); db.close(); rmSync(folder, { recursive: true, force: true });
    }
  });
}

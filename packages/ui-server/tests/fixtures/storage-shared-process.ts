import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createUiDb } from "../../src/db/client.js";
import { createStorageHistory } from "../../src/storage/history-store.js";
import { createSharedStorageScan } from "../../src/storage/shared-scan.js";
import { createStorageCoordinator } from "../../src/storage/coordinator.js";
import { storageProcess, storageReaderSource } from "../../src/storage/process.js";
import { hashScope } from "../../src/storage/history-model.js";
import { processStart } from "../../src/brain/writer-gate.js";
const [root, mode, marker] = process.argv.slice(2) as [string, string, string];
const brain = join(root, "brain"), db = createUiDb(join(root, "operations.sqlite")), history = createStorageHistory(db, brain);
const shared = createSharedStorageScan(db, brain, join(root, "cache"), id => id === "odysseus-owner");
if (mode === "collect" || mode === "collect-held") {
  let collections = 0;
  const controller = new AbortController();
  const stop = () => { controller.abort(); void coordinator.close(); };
  process.on("SIGTERM", stop);
  // Hold the owner's real lease before collection, rather than relying on how
  // quickly the scheduler happens to start the second native process.
  const held = { ...shared, async reap(scan: Parameters<typeof shared.reap>[0]) {
    await shared.reap(scan);
    if (mode !== "collect-held") return;
    const timeout = setTimeout(stop, 10_000);
    try {
      while (!existsSync(marker)) await pause(10, undefined, { signal: controller.signal });
      controller.signal.throwIfAborted();
    } finally { clearTimeout(timeout); }
  } };
  const coordinator = createStorageCoordinator({ brainPath: brain, stores: [], salt: history.read()!.metadata.state.salt, shared: held,
    authorized: id => id === "odysseus-owner", onCollection() { collections++; } });
  try {
    console.log("READY");
    await Bun.stdin.text();
    controller.signal.throwIfAborted();
    const result = coordinator.start("odysseus-owner", true);
    console.log(JSON.stringify({ started: result.activeScanId }));
    await coordinator.idle();
    const status = coordinator.status("odysseus-owner"), snapshot = status.snapshot ?? status.previous;
    if (!snapshot) throw Error(JSON.stringify(status.lastFailure));
    const page = coordinator.page("odysseus-owner", snapshot.id, {});
    console.log(JSON.stringify({ requested: result.activeScanId, id: snapshot.id, collections, names: page.entries.map(row => row.name), failure: status.lastFailure }));
  } finally {
    controller.abort();
    await coordinator.close();
    process.off("SIGTERM", stop);
    db.close();
  }
} else {
  const lease = shared.acquire("odysseus-owner", randomUUID(), hashScope("Odysseus guard fixture"), 1, true)!;
  await shared.reap(lease);
  await storageProcess([process.execPath, "--config=/dev/null", "--no-env-file", "-e", storageReaderSource("setInterval(()=>{},1000); await new Promise(()=>{});")], {
    signal: new AbortController().signal,
    lease: {
      register(pid) {
        if (mode !== "before-register") shared.register(lease, pid);
        writeFileSync(marker, JSON.stringify({ pid, start: processStart(pid), lease: lease.id }) + "\n");
        if (mode === "before-register") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      },
      unregister(pid) { shared.unregister(lease, pid); },
    },
  });
}

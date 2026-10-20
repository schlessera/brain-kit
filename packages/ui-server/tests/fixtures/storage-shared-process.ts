import { join } from "node:path";
import { writeFileSync } from "node:fs";
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
if (mode === "collect") {
  let collections = 0;
  const coordinator = createStorageCoordinator({ brainPath: brain, stores: [], salt: history.read()!.metadata.state.salt, shared,
    authorized: id => id === "odysseus-owner", onCollection() { collections++; } });
  console.log("READY");
  await Bun.stdin.text();
  const result = coordinator.start("odysseus-owner", true);
  await coordinator.idle();
  const status = coordinator.status("odysseus-owner"), snapshot = status.snapshot ?? status.previous;
  if (!snapshot) throw Error(JSON.stringify(status.lastFailure));
  const page = coordinator.page("odysseus-owner", snapshot.id, {});
  console.log(JSON.stringify({ requested: result.activeScanId, id: snapshot.id, collections, names: page.entries.map(row => row.name), failure: status.lastFailure }));
  await coordinator.close(); db.close();
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

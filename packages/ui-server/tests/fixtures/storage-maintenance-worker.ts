/** Real process-death receipt fixture. Never used by production. */
import { writeFileSync } from "node:fs";
import { createUiDb } from "../../src/db/client.js";
import { createStorageCoordinator } from "../../src/storage/coordinator.js";
import { createStorageMaintenance } from "../../src/storage/maintenance.js";
const [dbPath, brainPath, marker, id] = process.argv.slice(2) as [string,string,string,string];
const db = createUiDb(dbPath), storage = createStorageCoordinator({ brainPath, stores: [], authorized: () => true });
const operations = createStorageMaintenance(db, { brainPath, storage, authorized: () => true,
  boundary: { status: () => ({ hostExecution: "worker", available: true, profile: "strict", protectedPaths: [], identity: "shared_uid", configurationView: "startup" }) },
  brain: { async storagePack() { writeFileSync(marker, "owner entered after durable intent"); await new Promise(() => {}); } },
  scratch: { async tick() {}, async close() {}, async run() { return ""; } }, inbox: { cleanup: undefined },
});
operations.start("odysseus", { id, operation: "pack-git" });
await operations.idle();

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUiDb } from "../../src/db/client.js";
import { createStorageHistory } from "../../src/storage/history-store.js";
import { createStorageNotifier } from "../../src/storage/notify.js";
import { createPushSender } from "../../src/activity/push-sender.js";
const [root, mode, marker, rawAt] = process.argv.slice(2) as [string, string, string, string];
const at = Number(rawAt), db = createUiDb(join(root, "operations.sqlite"));
const history = createStorageHistory(db, root, { now: () => at }), notices = createStorageNotifier(db, history);
const sender = createPushSender(db, { send: async () => {
  appendFileSync(join(root, "transport-attempts.txt"), "attempt\n");
  if (mode === "crash") { writeFileSync(marker, "DISPATCHED\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); }
} });
console.log("READY"); await Bun.stdin.text();
console.log(JSON.stringify({ attempts: await sender.deliverStorage(notices, at) })); db.close();

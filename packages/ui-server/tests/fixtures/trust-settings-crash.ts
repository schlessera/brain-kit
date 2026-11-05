/** Process-death fixture: durable worker writes, real descriptors and publication. */
import { join } from "node:path";
import { createUiDb } from "../../src/db/client.js";
import { openSqliteWriter } from "../../src/db/write-worker.js";
import { createTrustSettings } from "../../src/brain/trust-settings.js";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
const [root, at, request] = process.argv.slice(2) as [string, string, string];
const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
const settings = createTrustSettings({ root, db, writer, lock: createKeyedLock(), authority: () => "owner-epoch",
  observe: async (_id, publish) => publish(), checkpoint: stage => { if (stage === at) process.exit(77); } });
const review = JSON.parse(await Bun.file(join(root, "request.json")).text());
if (at === "prepared") await settings.prepare("odysseus", review.input);
else await settings.commit("odysseus", { version: 1, requestId: request, reviewId: review.reviewId, reviewedBytesHash: review.reviewedBytesHash });
await writer.close(); db.close();

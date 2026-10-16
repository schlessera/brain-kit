/** Real Storage HTTP, filesystem, writer gate and journal. The copied native
 * fixture proves UI/owner integration; it does not qualify a Btrfs host. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "../../../ui-server/src/app-env.js";
import { storageRemovalFixture } from "../../../ui-server/tests/helpers/storage-removal-fixture.js";
import { testPrincipal } from "../../../ui-server/tests/helpers/principal.js";
import { createStorageRoutes } from "../../../ui-server/src/routes/storage.js";
import { createStorageRemovalRoutes } from "../../../ui-server/src/routes/storage-removal.js";
import { createPrincipal } from "../../../ui-server/src/db/principals.js";
import { createStorageHistory } from "../../../ui-server/src/storage/history-store.js";
import { createStorageNotifier } from "../../../ui-server/src/storage/notify.js";
import { createStorageGuidance } from "../../../ui-server/src/storage/guidance.js";
import { hashScope } from "../../../ui-server/src/storage/history-model.js";
const fixture = storageRemovalFixture(),
  target = join(fixture.brain, "attachments/chart.pdf"),
  original = Buffer.alloc(5_100_000, 65);
original.set([37, 80, 68, 70, 0, 255, 13, 10]);
writeFileSync(target, original);
const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex"),
  originalHash = digest(original);
fixture.storage.start("odysseus");
await fixture.storage.idle();
const owner = createPrincipal(fixture.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
fixture.db.query("UPDATE principals SET id = ? WHERE id = ?").run("odysseus", owner.id);
const history = createStorageHistory(fixture.db, fixture.brain), now = Date.now(), capacity = fixture.storage.status("odysseus").snapshot!.capacities[0]!;
// Deterministic pressure on the real HTTP projection, independent of host free space.
history.offer({ at: now, startedAt: now - 1000, source: 1, descriptor: ["0.44.0", hashScope("Ithaca"), 1], coverage: 0, reason: 0,
  capacities: [{ descriptor: [capacity.id, hashScope("Ithaca roots")], values: [1_000_000_000, 960_000_000, 40_000_000, 40_000_000, 0, 5_100_000, 5_103_616, 100_000, 102_400, 0, 0, 5_200_000, 5_206_016] }] });
const guidance = createStorageGuidance(fixture.db, history, fixture.storage, createStorageNotifier(fixture.db, history));
let drop = false,
  confirms = 0;
const app = new Hono<AppEnv>();
app.use("*", cors({ origin: (origin) => origin, credentials: true }));
app.use("*", async (c, next) => {
  c.set("principal", testPrincipal("odysseus"));
  const confirmation =
    c.req.path === "/api/storage/removals" && c.req.method === "POST";
  if (confirmation) confirms++;
  await next();
  if (confirmation && drop) {
    drop = false;
    await fixture.removal.idle();
    c.res = Response.json(
      { error: "Synthetic response loss after the real operation" },
      { status: 503 }
    );
  }
});
app.route("/api", createStorageRoutes(fixture.storage, guidance));
app.route("/api", createStorageRemovalRoutes(fixture.removal));
app.get("/api/storage/maintenance", (c) => c.json({ operations: [] }));
app.post("/fixture", async (c) => {
  const patch = await c.req.json();
  if (patch.drop) drop = true;
  if (patch.change)
    writeFileSync(target, Buffer.from("%PDF changed after review\n"));
  if (patch.revoke) fixture.revoke();
  return c.json({
    exists: existsSync(target),
    hash: existsSync(target) ? digest(readFileSync(target)) : null,
    originalHash,
    confirms,
    latest: fixture.removal.capability("odysseus").latest,
  });
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
process.on("SIGTERM", async () => {
  server.stop(true);
  history.close();
  await fixture.close();
  process.exit(0);
});
